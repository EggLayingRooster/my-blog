import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id } from "./helper";

export const AdminAuditLogsTable = sqliteTable(
  "admin_audit_logs",
  {
    id,
    userId: text("user_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadata: text("metadata"),
    createdAt,
  },
  (table) => [
    index("admin_audit_created_idx").on(table.createdAt),
    index("admin_audit_resource_idx").on(
      table.resourceType,
      table.resourceId,
      table.createdAt,
    ),
  ],
);
