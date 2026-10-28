import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { serverEnv } from "@/lib/env/server.env";
import { adminMiddleware } from "@/lib/middlewares";
import {
  GetOAuthClientMetadataInputSchema,
  OAuthScopeListSchema,
} from "../../oauth-clients/schema/oauth-client.schema";
import {
  OAUTH_PROVIDER_CONSENT_PAGE,
  resolveOAuthRequestedScopes,
} from "../oauth-provider.shared";
import { parseOAuthScopes } from "../service/oauth-provider.service";

const CompleteOAuthConsentInputSchema = z.object({
  accept: z.boolean(),
  oauthQuery: z.string(),
  scope: OAuthScopeListSchema,
});

export const getOAuthClientMetadataFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(GetOAuthClientMetadataInputSchema)
  .handler(async ({ context, data }) => {
    const OAuthClientService = await import(
      "../../oauth-clients/service/oauth-client.service"
    );

    return OAuthClientService.getOAuthClientMetadata(context, data.clientId);
  });

export const completeOAuthConsentFn = createServerFn({
  method: "POST",
})
  .middleware([adminMiddleware])
  .inputValidator(CompleteOAuthConsentInputSchema)
  .handler(async ({ context, data }) => {
    const { getOAuthHelpers } = await import("../oauth-provider.config");
    const oauth = getOAuthHelpers(context.env);

    // oauthQuery 会被拼进 consent URL：只允许 query string，拒绝 fragment 等注入
    const rawQuery = data.oauthQuery.trim().replace(/^[?&]+/, "");
    if (!rawQuery || rawQuery.includes("#")) {
      throw new Error("Invalid OAuth query");
    }

    const baseUrl = serverEnv(context.env).BETTER_AUTH_URL;
    const consentUrl = new URL(OAUTH_PROVIDER_CONSENT_PAGE, baseUrl);
    consentUrl.search = `?${rawQuery}`;
    const request = await oauth.parseAuthRequest(new Request(consentUrl));

    // 只授予“原始请求 scope ∩ 管理员勾选 scope”，不接受前端凭空扩大 scope
    const requestedScopes = parseOAuthScopes(
      (request as unknown as { scope?: unknown }).scope,
    );
    const selectedScopes = resolveOAuthRequestedScopes(data.scope);
    const grantedScopes = data.accept
      ? requestedScopes.length > 0
        ? selectedScopes.filter((scope) => requestedScopes.includes(scope))
        : selectedScopes
      : [];

    if (!data.accept) {
      const redirectUrl = new URL(request.redirectUri);
      redirectUrl.searchParams.set("error", "access_denied");
      if (request.state) {
        redirectUrl.searchParams.set("state", request.state);
      }
      return {
        redirectTo: redirectUrl.toString(),
      };
    }

    return await oauth.completeAuthorization({
      metadata: {
        clientId: request.clientId,
      },
      props: {
        clientId: request.clientId,
        scopes: grantedScopes,
        subject: context.session.user.id,
        userId: context.session.user.id,
      },
      request,
      scope: grantedScopes,
      userId: context.session.user.id,
    });
  });
