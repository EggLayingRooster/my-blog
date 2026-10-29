import { WorkerEntrypoint } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp";
import { eq } from "drizzle-orm";
import { createOAuthPrincipalFromProps } from "@/features/oauth-provider/service/oauth-provider.service";
import { getDb } from "@/lib/db";
import { user as userTable } from "@/lib/db/schema";
import { createMcpServer } from "../service/mcp.server";
import {
  applyMcpOriginPolicy,
  createInvalidOriginResponse,
  isAllowedMcpOrigin,
} from "../utils/mcp-origin";

type OAuthProps = Record<string, unknown>;

function getOAuthProps(ctx: ExecutionContext): OAuthProps {
  const maybeContext = ctx as ExecutionContext & { props?: OAuthProps };
  return maybeContext.props ?? {};
}

export class McpApiHandler extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    if (!isAllowedMcpOrigin(request)) {
      return createInvalidOriginResponse();
    }

    const executionCtx = this.ctx as ExecutionContext;
    const authProps = getOAuthProps(executionCtx);
    const db = getDb(this.env);
    const principal = createOAuthPrincipalFromProps(authProps);

    if (!principal.subject) {
      return Response.json(
        { code: "UNAUTHORIZED", message: "Missing OAuth subject" },
        { headers: { "WWW-Authenticate": "Bearer" }, status: 401 },
      );
    }

    // token 签发后管理员可能被降权/封禁：每次 MCP 请求都校验当前账号状态
    const account = await db.query.user.findFirst({
      where: eq(userTable.id, principal.subject),
    });
    const banActive =
      !!account?.banned &&
      (!account.banExpires || account.banExpires.getTime() > Date.now());

    if (!account || account.role?.toLowerCase() !== "admin" || banActive) {
      return Response.json(
        {
          code: "FORBIDDEN",
          message: "MCP access requires an active admin account",
        },
        { status: 403 },
      );
    }

    // 按 token 主体/客户端限流，避免旧 token 或脚本高频写入
    try {
      const limiter = this.env.RATE_LIMITER.get(
        this.env.RATE_LIMITER.idFromName(
          `mcp:${principal.subject}:${principal.clientId ?? "unknown"}`,
        ),
      );
      const limit = await limiter.checkLimit({
        capacity: 120,
        interval: "1m",
      });
      if (!limit.allowed) {
        return Response.json(
          { code: "RATE_LIMITED", message: "Too many MCP requests" },
          { status: 429 },
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "mcp rate limit check failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    const server = await createMcpServer({
      db,
      env: this.env,
      executionCtx,
      principal,
    });

    const response = await createMcpHandler(
      server as unknown as Parameters<typeof createMcpHandler>[0],
      {
        authContext: {
          props: authProps,
        },
        route: "/mcp",
      },
    )(request, this.env, executionCtx);

    return applyMcpOriginPolicy(request, response);
  }
}
