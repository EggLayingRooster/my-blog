import { desc } from "drizzle-orm";
import { AdminAuditLogsTable } from "@/lib/db/schema";

export type AdminAuditRecord = {
  userId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown> | null;
};

export async function insertAdminAudit(
  db: DB,
  record: AdminAuditRecord,
): Promise<void> {
  await db.insert(AdminAuditLogsTable).values({
    userId: record.userId ?? null,
    action: record.action,
    resourceType: record.resourceType,
    resourceId:
      record.resourceId === undefined || record.resourceId === null
        ? null
        : String(record.resourceId),
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
  });
}

export async function listAdminAudit(
  db: DB,
  options: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  return await db
    .select()
    .from(AdminAuditLogsTable)
    .orderBy(desc(AdminAuditLogsTable.createdAt))
    .limit(limit)
    .offset(offset);
}
