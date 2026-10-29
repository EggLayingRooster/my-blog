import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth/minimal";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthEmail } from "@/features/email/templates/AuthEmail";
import { createAuthConfig } from "@/lib/auth/auth.config";
import * as authSchema from "@/lib/db/schema/auth.table";
import { serverEnv } from "@/lib/env/server.env";
import type { Locale } from "@/lib/i18n";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

async function checkEmailRateLimit(
  env: Env,
  scope: string,
  email: string,
  capacity = 3,
  interval: "1m" | "15m" | "1h" = "1h",
): Promise<boolean> {
  const identifier = `${scope}:${email.toLowerCase().trim()}`;
  const id = env.RATE_LIMITER.idFromName(identifier);
  const rateLimiter = env.RATE_LIMITER.get(id);
  const result = await rateLimiter.checkLimit({
    capacity,
    interval,
  });
  return result.allowed;
}

export function getAuth({ db, env }: { db: DB; env: Env }) {
  const {
    BETTER_AUTH_SECRET,
    BETTER_AUTH_URL,
    ADMIN_EMAIL,
    LOCALE,
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
  } = serverEnv(env);

  // 固定 10 个 DO 实例池，随机选择避免冷启动
  const PASSWORD_HASHER_POOL_SIZE = 10;
  function getPasswordHasher() {
    const index = Math.floor(Math.random() * PASSWORD_HASHER_POOL_SIZE);
    const id = env.PASSWORD_HASHER.idFromName(`hasher-${index}`);
    return env.PASSWORD_HASHER.get(id);
  }

  function getAuthEmailLocale(): Locale {
    try {
      return getLocale();
    } catch {
      return LOCALE;
    }
  }

  async function enqueueAccountEmail(
    type: "change-email",
    to: string,
    url: string,
  ) {
    const locale = getAuthEmailLocale();
    const emailHtml = renderToStaticMarkup(AuthEmail({ locale, type, url }));
    await env.QUEUE.send({
      type: "EMAIL",
      data: {
        to,
        subject: m.email_auth_change_email_subject({}, { locale }),
        html: emailHtml,
      },
    });
  }

  return betterAuth({
    ...createAuthConfig(),
    trustedOrigins: [BETTER_AUTH_URL],
    socialProviders: {
      github: {
        clientId: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-in/email") {
          const email =
            typeof ctx.body?.email === "string"
              ? ctx.body.email.trim().toLowerCase()
              : "";
          if (email) {
            const allowed = await checkEmailRateLimit(
              env,
              "email-signin",
              email,
              10,
              "15m",
            );
            if (!allowed) {
              console.error(
                JSON.stringify({ message: "sign-in rate limited", email }),
              );
              throw APIError.from("TOO_MANY_REQUESTS", {
                code: "RATE_LIMITED",
                message: "Too many sign in attempts",
              });
            }
          }
          return;
        }

        if (ctx.path === "/update-user") {
          const image =
            typeof ctx.body?.image === "string" ? ctx.body.image.trim() : "";
          if (image) {
            let allowed = image.startsWith("/images/");
            try {
              const url = new URL(image);
              const authOrigin = new URL(BETTER_AUTH_URL).origin;
              allowed =
                allowed ||
                (url.protocol === "https:" &&
                  (url.origin === authOrigin ||
                    url.hostname === "avatars.githubusercontent.com" ||
                    url.hostname === "github.com" ||
                    url.hostname === "www.gravatar.com" ||
                    url.hostname === "secure.gravatar.com"));
            } catch {
              allowed = false;
            }
            if (!allowed) {
              throw APIError.from("BAD_REQUEST", {
                code: "INVALID_PROFILE_IMAGE",
                message: "Profile image must be an uploaded media URL",
              });
            }
          }
          return;
        }

        if (ctx.path !== "/sign-up/email") return;

        const email =
          typeof ctx.body?.email === "string" ? ctx.body.email.trim() : "";
        if (!email) return;

        // 禁止公开注册管理员邮箱：否则攻击者可抢注该邮箱（未验证即拥有 admin role），
        // 造成管理员账号被占用，或诱导邮箱真实主人点击验证链接完成“账号预劫持”。
        if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
          throw APIError.from("BAD_REQUEST", {
            code: "ADMIN_EMAIL_SIGNUP_FORBIDDEN",
            message: "This email cannot be used for public sign up",
          });
        }

        // 注册阶段不暴露“邮箱是否已存在”，避免账号枚举
        const existingUser = await db.query.user.findFirst({
          where: eq(authSchema.user.email, email.toLowerCase()),
        });
        if (existingUser) {
          throw APIError.from("BAD_REQUEST", {
            code: "REGISTRATION_UNAVAILABLE",
            message: "Registration could not be completed",
          });
        }

        const allowed = await checkEmailRateLimit(env, "email-signup", email);
        if (allowed) return;

        console.error(
          JSON.stringify({
            message: "email signup rate limited",
            email,
          }),
        );
        throw APIError.from("BAD_REQUEST", {
          code: "RATE_LIMITED",
          message: "Too many sign up attempts",
        });
      }),
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: (password: string) => getPasswordHasher().hash(password),
        verify: (params: { hash: string; password: string }) =>
          getPasswordHasher().verify(params),
      },
      sendResetPassword: async ({ user, url }) => {
        // Per-email rate limit: 3 per hour
        const allowed = await checkEmailRateLimit(
          env,
          "email-reset",
          user.email,
        );
        if (!allowed) {
          console.error(
            JSON.stringify({
              message: "reset password email rate limited",
              email: user.email,
            }),
          );
          return;
        }

        const locale = getAuthEmailLocale();
        const emailHtml = renderToStaticMarkup(
          AuthEmail({ locale, type: "reset-password", url }),
        );

        try {
          await env.QUEUE.send({
            type: "EMAIL",
            data: {
              to: user.email,
              subject: m.email_auth_reset_subject({}, { locale }),
              html: emailHtml,
            },
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "auth email enqueue failed",
              kind: "reset-password",
              email: user.email,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          throw error;
        }
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        // Per-email rate limit: 3 per hour — silently skip if exceeded
        const allowed = await checkEmailRateLimit(
          env,
          "email-verify",
          user.email,
        );
        if (!allowed) {
          console.error(
            JSON.stringify({
              message: "verification email rate limited",
              email: user.email,
            }),
          );
          throw APIError.from("TOO_MANY_REQUESTS", {
            code: "RATE_LIMITED",
            message: "Verification email rate limited",
          });
        }

        const locale = getAuthEmailLocale();
        const emailHtml = renderToStaticMarkup(
          AuthEmail({ locale, type: "verification", url }),
        );

        try {
          await env.QUEUE.send({
            type: "EMAIL",
            data: {
              to: user.email,
              subject: m.email_auth_verification_subject({}, { locale }),
              html: emailHtml,
            },
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              message: "auth email enqueue failed",
              kind: "verification",
              email: user.email,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          throw error;
        }
      },
      autoSignInAfterVerification: false,
    },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, url }) => {
          await enqueueAccountEmail("change-email", user.email, url);
        },
      },
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          const role =
            typeof (user as unknown as { role?: unknown }).role === "string"
              ? (user as unknown as { role: string }).role.toLowerCase()
              : undefined;
          // 管理员账号由 ADMIN_EMAIL 环境变量初始化，禁止通过自助删除移除
          if (role === "admin") {
            throw APIError.from("FORBIDDEN", {
              code: "ADMIN_ACCOUNT_DELETE_FORBIDDEN",
              message: "Admin account cannot be deleted from the profile page",
            });
          }
        },
      },
    },
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: authSchema,
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // 大小写不敏感；仅用于 GitHub 等已由第三方验证邮箱的社交注册。
            // 邮箱密码注册已在上方 before hook 禁止使用 ADMIN_EMAIL。
            const email =
              typeof user.email === "string"
                ? user.email.toLowerCase()
                : undefined;
            if (email === ADMIN_EMAIL.toLowerCase()) {
              return { data: { ...user, role: "admin" } };
            }
            return { data: user };
          },
        },
        update: {
          after: async (user) => {
            const role =
              typeof (user as unknown as { role?: unknown }).role === "string"
                ? (user as unknown as { role: string }).role.toLowerCase()
                : undefined;
            const banned =
              (user as unknown as { banned?: unknown }).banned === true;
            // 降权/封禁后主动撤销 MCP OAuth grants，避免 refresh token 长期保留
            if (role === "admin" && !banned) return;
            try {
              const { getOAuthHelpers } = await import(
                "@/features/oauth-provider/oauth-provider.config"
              );
              const oauth = getOAuthHelpers(env);
              const { items } = await oauth.listUserGrants(user.id, {
                limit: 1000,
              });
              await Promise.all(
                items.map((grant) =>
                  oauth.revokeGrant(grant.id, user.id).catch((error) => {
                    console.error(
                      JSON.stringify({
                        message: "oauth grant revoke failed",
                        userId: user.id,
                        grantId: grant.id,
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      }),
                    );
                  }),
                ),
              );
            } catch (error) {
              console.error(
                JSON.stringify({
                  message: "oauth grants revoke after user update failed",
                  userId: user.id,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            }
          },
        },
      },
    },
    secret: BETTER_AUTH_SECRET,
    baseURL: BETTER_AUTH_URL,
  });
}

export type Auth = ReturnType<typeof getAuth>;
export type Session = Auth["$Infer"]["Session"];
