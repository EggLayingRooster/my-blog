import { createMiddleware } from "@tanstack/react-start";
import {
  getRequestHeader,
  getRequestHeaders,
} from "@tanstack/react-start/server";
import { getAuth } from "@/lib/auth/auth.server";
import { getDb } from "@/lib/db";
import type { RateLimitOptions } from "@/lib/do/rate-limiter";
import { serverEnv } from "@/lib/env/server.env";
import {
  createAuthError,
  createPermissionError,
  createRateLimitError,
  createTurnstileError,
} from "@/lib/errors";
import { verifyTurnstileToken } from "@/lib/turnstile";

/* ======================= Error Logging ====================== */

export const errorLoggingMiddleware = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "server function error",
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    throw error;
  }
});

/* ======================= Infrastructure ====================== */

export const dbMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, context }) => {
    const db = getDb(context.env);
    return next({
      context: {
        db,
      },
    });
  },
);

export const sessionMiddleware = createMiddleware({ type: "function" })
  .middleware([dbMiddleware])
  .server(async ({ next, context }) => {
    const auth = getAuth({
      db: context.db,
      env: context.env,
    });
    const session = await auth.api.getSession({
      headers: getRequestHeaders(),
    });

    return next({
      context: {
        auth,
        session,
      },
    });
  });

export const authMiddleware = createMiddleware({ type: "function" })
  .middleware([sessionMiddleware])
  .server(async ({ next, context }) => {
    const session = context.session;

    if (!session) {
      throw createAuthError();
    }

    return next({
      context: {
        session,
      },
    });
  });

export const adminMiddleware = createMiddleware({ type: "function" })
  .middleware([authMiddleware])
  .server(async ({ context, next }) => {
    const session = context.session;

    if (session.user.role !== "admin") {
      throw createPermissionError();
    }

    return next({
      context: {
        session,
      },
    });
  });

/* ======================= Rate Limiting ====================== */
export const createRateLimitMiddleware = (
  options: RateLimitOptions & { key?: string },
) => {
  return createMiddleware({ type: "function" })
    .middleware([sessionMiddleware])
    .server(async ({ next, context }) => {
      const session = context.session;

      const identifier =
        getRequestHeader("cf-connecting-ip") || session?.user.id || "unknown";
      const scope = options.key || "default";
      const uniqueIdentifier = `${identifier}:${scope}`;

      const id = context.env.RATE_LIMITER.idFromName(uniqueIdentifier);
      const rateLimiter = context.env.RATE_LIMITER.get(id);

      const result = await rateLimiter.checkLimit(options);

      if (!result.allowed) {
        throw createRateLimitError(result.retryAfterMs);
      }

      return next();
    });
};

/* ======================= Turnstile ====================== */
export const turnstileMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    // Dynamically import to avoid SSR issues
    const { getTurnstileToken } = await import("@/components/common/turnstile");
    const token = getTurnstileToken();
    return next({
      headers: {
        "X-Turnstile-Token": token || "",
      },
    });
  })
  .server(async ({ next, context }) => {
    const env = serverEnv(context.env);
    const secretKey = env.TURNSTILE_SECRET_KEY;
    const isProduction = env.ENVIRONMENT !== "dev" && env.ENVIRONMENT !== "test";
    if (!secretKey) {
      // 生产环境 fail-closed：缺少 secret 不能静默放行
      if (isProduction) {
        console.error(
          JSON.stringify({
            message: "turnstile secret missing in production, rejecting request",
          }),
        );
        throw createTurnstileError("VERIFY_FAILED");
      }
      return next();
    }

    const token = getRequestHeader("X-Turnstile-Token");
    if (!token) {
      throw createTurnstileError("MISSING_TOKEN");
    }

    const result = await verifyTurnstileToken({
      secretKey,
      token,
      expectedHostname: isProduction ? env.DOMAIN : undefined,
    });

    if (!result.success) {
      throw createTurnstileError("VERIFY_FAILED");
    }

    return next();
  });
