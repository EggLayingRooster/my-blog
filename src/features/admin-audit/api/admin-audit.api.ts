import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { listAdminAuditLogs } from "@/features/admin-audit/service/admin-audit.service";
import { adminMiddleware } from "@/lib/middlewares";

const ListAdminAuditInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const getAdminAuditLogsFn = createServerFn()
  .middleware([adminMiddleware])
  .inputValidator(ListAdminAuditInputSchema)
  .handler(({ data, context }) => listAdminAuditLogs(context, data));
