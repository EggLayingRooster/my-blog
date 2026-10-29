import { recordAdminAudit } from "@/features/admin-audit/service/admin-audit.service";
import * as OAuthClientRepo from "../data/oauth-client.data";
import type { RenameOAuthClientInput } from "../schema/oauth-client.schema";

export async function listOAuthConnections(context: AuthContext) {
  return OAuthClientRepo.listOAuthConnectionsByUserId(
    context.env,
    context.session.user.id,
  );
}

export async function renameOAuthClient(
  context: AuthContext,
  data: RenameOAuthClientInput,
) {
  const client = await OAuthClientRepo.updateOAuthClientName(
    context.env,
    data.clientId,
    data.clientName,
  );

  if (!client) {
    throw new Error("Client not found");
  }

  await recordAdminAudit(context, {
    action: "oauth_client.rename",
    resourceType: "oauth_client",
    resourceId: client.clientId,
    metadata: { clientName: client.clientName ?? data.clientName },
  });

  return {
    clientId: client.clientId,
    clientName: client.clientName ?? data.clientName,
  };
}

export async function deleteOAuthConnection(
  context: AuthContext,
  consentId: string,
) {
  await OAuthClientRepo.deleteOAuthConsentById(
    context.env,
    consentId,
    context.session.user.id,
  );

  await recordAdminAudit(context, {
    action: "oauth_connection.delete",
    resourceType: "oauth_connection",
    resourceId: consentId,
  });

  return { success: true };
}
export async function getOAuthClientMetadata(
  context: DbContext,
  clientId: string,
) {
  return OAuthClientRepo.findOAuthClientByClientId(context.env, clientId);
}
