import * as AuthRepo from "@/features/auth/data/auth.data";
import * as ConfigService from "@/features/config/service/config.service";
import { getDb } from "@/lib/db";

export async function getSession(context: SessionContext) {
  return context.session;
}

export async function userHasPassword(context: AuthContext) {
  return await AuthRepo.userHasPassword(context.db, context.session.user.id);
}

export async function getIsEmailConfigured(
  context: DbContext & { executionCtx: ExecutionContext },
) {
  const config = await ConfigService.getSystemConfig(context);
  return !!(
    config?.email?.host &&
    config.email.username &&
    config.email.password &&
    config.email.senderAddress
  );
}

/** scheduled 任务：清理过期 session 与验证 token */
export async function cleanupExpiredAuthRecords(env: Env): Promise<void> {
  const db = getDb(env);
  await Promise.all([
    AuthRepo.deleteExpiredSessions(db),
    AuthRepo.deleteExpiredVerifications(db),
  ]);
  console.log(JSON.stringify({ message: "auth cleanup completed" }));
}
