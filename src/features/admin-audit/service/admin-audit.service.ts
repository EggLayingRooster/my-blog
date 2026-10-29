import * as AdminAuditRepo from "@/features/admin-audit/data/admin-audit.data";

export async function recordAdminAudit(
  context: DbContext & { session?: { user: { id: string } } },
  record: {
    action: string;
    resourceType: string;
    resourceId?: string | number | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await AdminAuditRepo.insertAdminAudit(context.db, {
      ...record,
      userId: context.session?.user.id ?? null,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "admin audit insert failed",
        action: record.action,
        resourceType: record.resourceType,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function listAdminAuditLogs(
  context: DbContext,
  options: { limit?: number; offset?: number } = {},
) {
  return await AdminAuditRepo.listAdminAudit(context.db, options);
}
