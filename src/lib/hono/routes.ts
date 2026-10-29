import handler from "@tanstack/react-start/server-entry";
import type { Context } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import * as EmailService from "@/features/email/service/email.service";
import { EMAIL_UNSUBSCRIBE_TYPES } from "@/lib/db/schema";
import { proxy } from "hono/proxy";
import { exportDownloadRoute } from "@/features/import-export/api/hono/download.route";
import { handleImageRequest } from "@/features/media/service/media.service";
import {
  isValidMediaKey,
  normalizeImageQuery,
} from "@/features/media/utils/media.utils";
import postsDetailRoute from "@/features/posts/api/hono/posts.detail.route";
import postsListRoute from "@/features/posts/api/hono/posts.list.route";
import postsRelatedRoute from "@/features/posts/api/hono/posts.related.route";
import searchRoute from "@/features/search/api/hono/search.route";
import siteDocumentsRoute from "@/features/site-documents/api/hono/site-documents.route";
import tagsRoute from "@/features/tags/api/hono/tags.list.route";
import { serverEnv } from "@/lib/env/server.env";
import { createRateLimiterIdentifier, getExecutionContext } from "./helper";
import {
  baseMiddleware,
  cacheMiddleware,
  rateLimitMiddleware,
  shieldMiddleware,
  turnstileMiddleware,
} from "./middlewares";

export const app = new Hono<{ Bindings: Env }>();

app.get("*", cacheMiddleware);

async function forwardAuthRequest(c: Context<{ Bindings: Env }>) {
  const auth = c.get("auth");
  return auth.handler(c.req.raw);
}

/* ================================ Public API ================================ */

// Public API routes with RPC support - 链式调用保留类型推断
const publicApi = new Hono<{ Bindings: Env }>()
  .route("/posts", postsListRoute)
  .route("/post", postsDetailRoute)
  .route("/post", postsRelatedRoute)
  .route("/tags", tagsRoute)
  .route("/search", searchRoute);

// Mount public API
app.route("/api", publicApi);

app.route("/", siteDocumentsRoute);

// Export type for RPC client
export type PublicApiType = typeof publicApi;

/* ================================ 路由开始 ================================ */
app.get("/stats.js", async (c) => {
  const env = serverEnv(c.env);
  const umamiSrc = env.UMAMI_SRC;
  if (!umamiSrc) {
    return c.text("Not Found", 404);
  }
  const scriptUrl = new URL("/script.js", umamiSrc).toString();
  const response = await proxy(scriptUrl);
  response.headers.set(
    "Cache-Control",
    "public, max-age=3600, stale-while-revalidate=86400",
  );
  return response;
});

app.all("/api/send", async (c) => {
  const env = serverEnv(c.env);
  const umamiSrc = env.UMAMI_SRC;
  if (!umamiSrc) {
    return c.text("Not Found", 404);
  }

  const sourceUrl = new URL(umamiSrc);
  // Umami Cloud 的采集端点是 gateway.umami.is；自建实例才使用自己的 /api/send。
  const sendUrl =
    sourceUrl.hostname === "cloud.umami.is" ||
    sourceUrl.hostname === "gateway.umami.is"
      ? "https://gateway.umami.is/api/send"
      : new URL("/api/send", sourceUrl).toString();

  const clientIp = c.req.header("cf-connecting-ip");
  return proxy(sendUrl, {
    raw: c.req.raw,
    headers: {
      ...c.req.header(),
      ...(clientIp
        ? { "x-forwarded-for": clientIp, "x-real-ip": clientIp }
        : {}),
    },
  });
});

const imageRateLimit = createMiddleware(async (c, next) => {
  // Image Resizing 的内部子请求不占用用户图片限流额度
  if (c.req.header("via")?.includes("image-resizing")) {
    return next();
  }

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  try {
    const limiter = c.env.RATE_LIMITER.get(
      c.env.RATE_LIMITER.idFromName(`image:${ip}`),
    );
    const limit = await limiter.checkLimit({ capacity: 300, interval: "1m" });
    if (!limit.allowed) {
      return c.text("Too Many Requests", 429);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "image rate limit check failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return next();
});

app.get("/images/:key{.+}", imageRateLimit, async (c) => {
  const key = c.req.param("key");

  // 只允许媒体对象（UUID 文件名）或站点资源（asset/ 前缀）。
  if (!key || !isValidMediaKey(key)) {
    return c.text("Not Found", 404);
  }

  const url = new URL(c.req.url);
  const normalized = normalizeImageQuery(url.searchParams, {
    isAsset: key.startsWith("asset/"),
  });
  if (!normalized.ok) {
    return c.text("Invalid image query", 400);
  }

  const canonicalUrl = new URL(url);
  canonicalUrl.search = normalized.query.toString();
  if (canonicalUrl.search !== url.search) {
    return c.redirect(canonicalUrl.toString(), 308);
  }

  try {
    return await handleImageRequest(c.env, key, c.req.raw);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "r2 image fetch failed",
        key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return c.text("Internal server error", 500);
  }
});

app.get(
  "/api/auth/*",
  baseMiddleware,
  rateLimitMiddleware({
    capacity: 120,
    interval: "1m",
    identifier: (c) =>
      `auth-get:${c.req.header("cf-connecting-ip") ?? "unknown"}`,
  }),
  forwardAuthRequest,
);

const protectedAuthPaths = [
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
  "/api/auth/request-password-reset",
  "/api/auth/send-verification-email",
] as const;

// 所有认证请求共享的全局桶：避免攻击者在多个 auth 路径间轮换绕过单路径限流
const authGlobalRateLimit = rateLimitMiddleware({
  capacity: 30,
  interval: "1m",
  identifier: (c) =>
    `auth-global:${c.req.header("cf-connecting-ip") ?? "unknown"}`,
});

protectedAuthPaths.forEach((path) => {
  app.post(
    path,
    baseMiddleware,
    turnstileMiddleware,
    authGlobalRateLimit,
    rateLimitMiddleware({
      capacity: 5,
      interval: "1m",
      identifier: createRateLimiterIdentifier,
    }),
    rateLimitMiddleware({
      capacity: 10,
      interval: "1h",
      identifier: (c) => `hourly:${createRateLimiterIdentifier(c)}`,
    }),
    forwardAuthRequest,
  );
});

app.post(
  "/api/auth/*",
  baseMiddleware,
  authGlobalRateLimit,
  rateLimitMiddleware({
    capacity: 5,
    interval: "1m",
    identifier: createRateLimiterIdentifier,
  }),
  forwardAuthRequest,
);

// Admin export download route
app.route("/api/admin/export", exportDownloadRoute);

const unsubscribeQuerySchema = z.object({
  userId: z.string().min(1),
  type: z.enum(EMAIL_UNSUBSCRIBE_TYPES),
  token: z.string().min(1),
});

/**
 * RFC 8058 One-Click Unsubscribe 端点。
 * 邮件客户端会向邮件头 List-Unsubscribe 里的 URL 发送 POST，而不是打开页面。
 */
app.post("/unsubscribe", baseMiddleware, async (c) => {
  const parsed = unsubscribeQuerySchema.safeParse({
    userId: c.req.query("userId"),
    type: c.req.query("type"),
    token: c.req.query("token"),
  });

  if (!parsed.success) {
    return c.text("Invalid unsubscribe request", 400);
  }

  try {
    const result = await EmailService.unsubscribeByToken(
      { db: c.get("db"), env: c.env },
      parsed.data,
    );
    if (result.error) {
      return c.text("Invalid or expired token", 400);
    }
    c.header("Cache-Control", "no-store");
    return c.body(null, 204);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "one-click unsubscribe failed",
        userId: parsed.data.userId,
        type: parsed.data.type,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return c.text("Unsubscribe failed", 500);
  }
});

// Router之前的防护
app.all("*", shieldMiddleware);

app.all("*", (c) => {
  return handler.fetch(c.req.raw, {
    context: {
      env: c.env,
      executionCtx: getExecutionContext(c),
    },
  });
});
