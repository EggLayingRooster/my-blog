import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getAuth } from "@/lib/auth/auth.server";
import { CACHE_CONTROL } from "@/lib/constants";
import { getDb } from "@/lib/db";
import type { Duration } from "@/lib/duration";
import { serverEnv } from "@/lib/env/server.env";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { isPathValid } from "./path-manifest.generated";

declare module "hono" {
  interface ContextVariableMap {
    db: ReturnType<typeof getDb>;
    auth: ReturnType<typeof getAuth>;
  }
}

export const baseMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const db = getDb(c.env);
    const auth = getAuth({ db, env: c.env });
    c.set("db", db);
    c.set("auth", auth);
    return next();
  },
);

const tryCacheResponse = (c: Context, cache: Cache) => {
  let strategy:
    | typeof CACHE_CONTROL.notFound
    | typeof CACHE_CONTROL.serverError
    | typeof CACHE_CONTROL.forbidden
    | null = null;
  if (c.res.status === 404) {
    strategy = CACHE_CONTROL.notFound;
  } else if (c.res.status >= 500) {
    strategy = CACHE_CONTROL.serverError;
  }
  if (strategy) {
    Object.entries(strategy).forEach(([k, v]) => {
      c.res.headers.set(k, v);
    });
  }

  const resCacheControl = c.res.headers.get("Cache-Control");
  const hasSetCookie = c.res.headers.has("Set-Cookie");

  const isStatusCacheable =
    c.res.status === 200 || c.res.status === 404 || c.res.status >= 500;

  const isCacheable =
    isStatusCacheable &&
    !hasSetCookie &&
    resCacheControl &&
    !resCacheControl.includes("no-store") &&
    !resCacheControl.includes("no-cache") &&
    !resCacheControl.includes("private");

  if (!isCacheable) return;

  // HTML 页面随 locale 变化，禁止进入共享 Cache API（避免语言串页/旧页面长期残留）
  const contentType = c.res.headers.get("Content-Type") ?? "";
  if (contentType.toLowerCase().includes("text/html")) return;

  const responseToCache = c.res.clone();
  c.executionCtx.waitUntil(
    cache.put(c.req.raw, responseToCache).catch(() => {}),
  );
};

/** 只有这些前缀的 GET 响应才走共享缓存；HTML 页面由 cacheMiddleware 直接跳过 */
const SHARED_CACHE_PREFIXES = [
  "/api/",
  "/images/",
  "/assets/",
  "/_serverFn/",
  "/stats.js",
  "/rss.xml",
  "/atom.xml",
  "/feed.json",
  "/sitemap.xml",
  "/robots.txt",
  "/site.webmanifest",
] as const;

export const cacheMiddleware = createMiddleware(async (c, next) => {
  if (c.req.method !== "GET") {
    return next();
  }

  const path = c.req.path;

  const isSharedCacheablePath = SHARED_CACHE_PREFIXES.some((prefix) =>
    path.startsWith(prefix),
  );
  if (!isSharedCacheablePath) {
    // 页面 HTML（以及其它非白名单路径）不做 Cache API 共享缓存：
    // 内容随 locale/cookie 变化，按 URL 缓存会串语言，也无法在部署后自动失效。
    return next();
  }

  // 排除需要 session 的 API（如 /api/auth, /api/send）
  // 但包含 public API（/api/posts, /api/post, /api/tags, /api/search）
  const EXCLUDED_PREFIXES = ["/api/auth", "/api/send"];
  if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return next();
  }

  // 缓存响应逻辑
  const cache = (caches as unknown as { default: Cache }).default;

  const cachedResponse = await cache.match(c.req.raw);
  if (cachedResponse) return cachedResponse;

  await next();

  tryCacheResponse(c, cache);
});

const SHIELD_ALLOWED_PATHS = new Set([
  "/atom.xml",
  "/feed.json",
  "/robots.txt",
  "/rss.xml",
  "/site.webmanifest",
  "/sitemap.xml",
]);

interface RateLimitOptions {
  capacity: number;
  interval: Duration;
  identifier: string | ((c: Context) => string | undefined);
}

export const rateLimitMiddleware = (options: RateLimitOptions) =>
  createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const identifier =
      typeof options.identifier === "function"
        ? options.identifier(c)
        : options.identifier;
    const id = c.env.RATE_LIMITER.idFromName(identifier ?? "unknown");
    const rateLimiter = c.env.RATE_LIMITER.get(id);

    const result = await rateLimiter.checkLimit({
      capacity: options.capacity,
      interval: options.interval,
    });

    if (!result.allowed) {
      c.res.headers.set("Retry-After", result.retryAfterMs.toString());
      return c.json(
        {
          code: "RATE_LIMITED",
          message: "Too Many Requests",
          retryAfterMs: result.retryAfterMs,
        },
        429,
      );
    }

    return next();
  });

export const shieldMiddleware = createMiddleware(async (c, next) => {
  if (serverEnv(c.env).ENVIRONMENT === "dev") return next();

  const path = c.req.path;

  if (
    // 静态资源
    path.startsWith("/assets/") ||
    path.startsWith("/favicon") ||
    SHIELD_ALLOWED_PATHS.has(path) ||
    path.startsWith("/apple-touch-icon") ||
    path.startsWith("/web-app-manifest") ||
    // Server Function
    path.startsWith("/_serverFn/")
  ) {
    return next();
  }

  if (isPathValid(path)) {
    return next();
  }
  const response = c.text("Not Found", 404);
  // 只缓存 Shield 拦截的 404，保护正常 404
  Object.entries(CACHE_CONTROL.notFound).forEach(([k, v]) => {
    response.headers.set(k, v);
  });
  return response;
});

/* ======================= Turnstile ====================== */
export const turnstileMiddleware = createMiddleware<{ Bindings: Env }>(
  async (c, next) => {
    const env = serverEnv(c.env);
    const secretKey = env.TURNSTILE_SECRET_KEY;
    const isProduction = env.ENVIRONMENT !== "dev" && env.ENVIRONMENT !== "test";
    if (!secretKey) {
      if (isProduction) {
        console.error(
          JSON.stringify({
            message: "turnstile secret missing in production, verification skipped",
          }),
        );
      }
      return next();
    }

    const token = c.req.header("X-Turnstile-Token");
    if (!token) {
      return c.json(
        {
          code: "TURNSTILE_MISSING_TOKEN",
          message: "Missing Turnstile token",
        },
        400,
      );
    }

    const path = c.req.path;
    const expectedAction =
      path === "/api/auth/sign-in/email"
        ? "login"
        : path === "/api/auth/sign-up/email"
          ? "register"
          : undefined;

    const result = await verifyTurnstileToken({
      secretKey,
      token,
      // 本地/测试环境使用 Turnstile 测试 key，hostname/action 不匹配，故跳过；
      // 生产环境强制校验来源站点与 action，避免 token 被跨站/跨用途重放。
      expectedAction: isProduction ? expectedAction : undefined,
      expectedHostname: isProduction
        ? new URL(c.req.url).hostname
        : undefined,
    });

    if (!result.success) {
      return c.json(
        {
          code: "TURNSTILE_VERIFICATION_FAILED",
          message: "Turnstile verification failed",
        },
        403,
      );
    }

    return next();
  },
);
