import { and, desc, eq, sql } from "drizzle-orm";
import {
  NotificationDeliveryLogsTable,
  type NotificationDeliveryChannel,
  type NotificationDeliveryStatus,
} from "@/lib/db/schema";

export type NotificationDeliveryRecord = {
  eventId: string;
  channel: NotificationDeliveryChannel;
  target?: string;
  status: NotificationDeliveryStatus;
  error?: string | null;
};

export async function upsertNotificationDelivery(
  db: DB,
  input: NotificationDeliveryRecord,
): Promise<void> {
  const target = input.target ?? "default";
  await db
    .insert(NotificationDeliveryLogsTable)
    .values({
      eventId: input.eventId,
      channel: input.channel,
      target,
      status: input.status,
      error: input.error ?? null,
    })
    .onConflictDoUpdate({
      target: [
        NotificationDeliveryLogsTable.eventId,
        NotificationDeliveryLogsTable.channel,
        NotificationDeliveryLogsTable.target,
      ],
      set: {
        status: input.status,
        error: input.error ?? null,
        attempts: sql`${NotificationDeliveryLogsTable.attempts} + 1`,
        updatedAt: new Date(),
      },
    });
}

export async function listNotificationDeliveries(
  db: DB,
  options: {
    limit?: number;
    offset?: number;
    status?: NotificationDeliveryStatus;
  } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const conditions = options.status
    ? [eq(NotificationDeliveryLogsTable.status, options.status)]
    : [];

  return await db
    .select()
    .from(NotificationDeliveryLogsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(NotificationDeliveryLogsTable.createdAt))
    .limit(limit)
    .offset(offset);
}
