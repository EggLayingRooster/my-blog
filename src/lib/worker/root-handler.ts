import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpApiHandler } from "@/features/mcp/api/mcp-api-handler";
import { createWorkersOAuthProviderOptions } from "@/features/oauth-provider/oauth-provider.config";
import {
  OAUTH_CLIENT_REGISTRATION_PATH,
  OAUTH_TOKEN_PATH,
} from "@/features/oauth-provider/oauth-provider.shared";
import { appWorkerHandler } from "./app-handler";

let oauthProvider: OAuthProvider<Env> | null = null;

function getOAuthProvider() {
  if (oauthProvider) {
    return oauthProvider;
  }

  oauthProvider = new OAuthProvider(
    createWorkersOAuthProviderOptions({
      apiHandlers: {
        "/mcp": McpApiHandler,
      },
      defaultHandler: appWorkerHandler,
    }),
  );

  return oauthProvider;
}

async function checkOAuthEndpointRateLimit(
  request: Request,
  env: Env,
  scope: "register" | "token",
): Promise<boolean> {
  const ip = request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
  const config =
    scope === "register"
      ? { capacity: 10, interval: "1h" as const }
      : { capacity: 120, interval: "1m" as const };

  try {
    const id = env.RATE_LIMITER.idFromName(`oauth:${scope}:${ip}`);
    const limiter = env.RATE_LIMITER.get(id);
    const result = await limiter.checkLimit(config);
    return result.allowed;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "oauth endpoint rate limit check failed",
        scope,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }
}

export async function handleRootRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) {
  if (request.method === "POST") {
    const pathname = new URL(request.url).pathname;

    if (
      pathname === OAUTH_TOKEN_PATH ||
      pathname === OAUTH_CLIENT_REGISTRATION_PATH
    ) {
      const scope =
        pathname === OAUTH_CLIENT_REGISTRATION_PATH ? "register" : "token";
      const allowed = await checkOAuthEndpointRateLimit(request, env, scope);
      if (!allowed) {
        return Response.json(
          { error: "too_many_requests" },
          { headers: { "Retry-After": "60" }, status: 429 },
        );
      }
    }
  }

  return getOAuthProvider().fetch(request, env, ctx);
}
