import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, updatedAt } from "./helper";

export const NOTIFICATION_DELIVERY_CHANNELS = ["email", "webhook"] as const;
export type NotificationDeliveryChannel =
  (typeof NOTIFICATION_DELIVERY_CHANNELS)[number];

export const NOTIFICATION_DELIVERY_STATUSES = [
  "success",
  "failed",
  "skipped",
] as const;
export type NotificationDeliveryStatus =
  (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

export const NotificationDeliveryLogsTable = sqliteTable(
  "notification_delivery_logs",
  {
    id,
    eventId: text("event_id").notNull(),
    channel: text("channel", { enum: NOTIFICATION_DELIVERY_CHANNELS }).notNull(),
    target: text("target").notNull().default("default"),
    status: text("status", { enum: NOTIFICATION_DELIVERY_STATUSES }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    error: text("error"),
    createdAt,
    updatedAt,
  },
  (table) => [
    uniqueIndex("notification_delivery_unique_idx").on(
      table.eventId,
      table.channel,
      table.target,
    ),
    index("notification_delivery_created_idx").on(table.createdAt),
    index("notification_delivery_status_idx").on(table.status, table.createdAt),
  ],
);
