import { useQuery } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { m } from "@/paraglide/messages";
import { getNotificationDeliveriesFn } from "../api/notification.admin.api";

const deliveriesQuery = queryOptions({
  queryKey: ["admin", "notification-deliveries"],
  queryFn: () => getNotificationDeliveriesFn({ data: { limit: 50 } }),
});

export function NotificationDeliveriesSection() {
  const { data = [], isLoading } = useQuery(deliveriesQuery);

  return (
    <section className="border border-border/30 bg-background/50 p-8">
      <div className="space-y-1 pb-6 border-b border-border/30">
        <h4 className="text-lg font-serif font-medium tracking-tight">
          {m.settings_notification_deliveries_title()}
        </h4>
        <p className="text-sm text-muted-foreground">
          {m.settings_notification_deliveries_desc()}
        </p>
      </div>

      {isLoading ? (
        <p className="py-8 text-sm text-muted-foreground">
          {m.settings_notification_deliveries_loading()}
        </p>
      ) : data.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">
          {m.settings_notification_deliveries_empty()}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="text-muted-foreground/60 uppercase tracking-wider">
              <tr>
                <th className="py-2 pr-4">time</th>
                <th className="py-2 pr-4">channel</th>
                <th className="py-2 pr-4">status</th>
                <th className="py-2 pr-4">target</th>
                <th className="py-2 pr-4">attempts</th>
                <th className="py-2">error</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="border-t border-border/10">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {new Date(row.createdAt).toLocaleString()}
                  </td>
                  <td className="py-2 pr-4">{row.channel}</td>
                  <td
                    className={
                      row.status === "failed"
                        ? "py-2 pr-4 text-destructive"
                        : "py-2 pr-4"
                    }
                  >
                    {row.status}
                  </td>
                  <td className="py-2 pr-4 max-w-[16rem] truncate">
                    {row.target}
                  </td>
                  <td className="py-2 pr-4">{row.attempts}</td>
                  <td className="py-2 max-w-[24rem] truncate text-muted-foreground">
                    {row.error ?? ""}
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
