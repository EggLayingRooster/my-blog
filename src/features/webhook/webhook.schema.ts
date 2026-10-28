import { z } from "zod";
import type { NotificationEvent } from "@/features/notification/notification.schema";
import { ADMIN_NOTIFICATION_EVENTS } from "@/features/notification/notification.schema";

export const NOTIFICATION_WEBHOOK_EVENTS = ADMIN_NOTIFICATION_EVENTS;

export const notificationWebhookEventTypeSchema = z.enum(
  NOTIFICATION_WEBHOOK_EVENTS,
);

export type NotificationWebhookEventType =
  (typeof NOTIFICATION_WEBHOOK_EVENTS)[number];

export function isNotificationWebhookEventType(
  event: NotificationEvent,
): event is Extract<
  NotificationEvent,
  { type: (typeof NOTIFICATION_WEBHOOK_EVENTS)[number] }
> {
  return NOTIFICATION_WEBHOOK_EVENTS.some((type) => type === event.type);
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^127\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

const webhookUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isPrivateOrLocalHost(url.hostname);
  } catch {
    return false;
  }
}, "Webhook URL must be a public HTTPS URL");

export const webhookEndpointSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  url: webhookUrlSchema,
  enabled: z.boolean(),
  // HMAC 密钥过短容易被暴力破解/伪造签名
  secret: z.string().min(16),
  events: z.array(notificationWebhookEventTypeSchema),
});
