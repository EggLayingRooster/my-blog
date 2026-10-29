import { queryOptions, useQuery } from "@tanstack/react-query";
import { getAdminAuditLogsFn } from "../api/admin-audit.api";
import { m } from "@/paraglide/messages";

const auditQuery = queryOptions({
  queryKey: ["admin", "audit-logs"],
  queryFn: () => getAdminAuditLogsFn({ data: { limit: 50 } }),
});

export function AdminAuditSection() {
  const { data = [], isLoading } = useQuery(auditQuery);

  return (
    <section className="border border-border/30 bg-background/50 p-8">
      <div className="space-y-1 pb-6 border-b border-border/30">
        <h4 className="text-lg font-serif font-medium tracking-tight">
          {m.settings_admin_audit_title()}
        </h4>
        <p className="text-sm text-muted-foreground">
          {m.settings_admin_audit_desc()}
        </p>
      </div>

      {isLoading ? (
        <p className="py-8 text-sm text-muted-foreground">
          {m.settings_admin_audit_loading()}
        </p>
      ) : data.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">
          {m.settings_admin_audit_empty()}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-muted-foreground/60 uppercase tracking-wider">
              <tr>
                <th className="py-2 pr-4">time</th>
                <th className="py-2 pr-4">user</th>
                <th className="py-2 pr-4">action</th>
                <th className="py-2 pr-4">resource</th>
                <th className="py-2">metadata</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="border-t border-border/10">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 max-w-[12rem] truncate">
                    {row.userId ?? ""}
                  </td>
                  <td className="py-2 pr-4">{row.action}</td>
                  <td className="py-2 pr-4">
                    {row.resourceType}
                    {row.resourceId ? `#${row.resourceId}` : ""}
                  </td>
                  <td className="py-2 max-w-[24rem] truncate text-muted-foreground">
                    {row.metadata ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
