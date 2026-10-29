import * as ConfigService from "@/features/config/service/config.service";
import { createEmailMessageFromNotification } from "@/features/email/service/email-message.mapper";
import type { NotificationEvent } from "@/features/notification/notification.schema";
import {
  ADMIN_NOTIFICATION_EVENTS,
  notificationEventSchema,
  USER_NOTIFICATION_EVENTS,
} from "@/features/notification/notification.schema";
import type { NotificationWebhookEventType } from "@/features/webhook/webhook.schema";
import { isNotificationWebhookEventType } from "@/features/webhook/webhook.schema";
import { serverEnv } from "@/lib/env/server.env";

function isAdminNotificationEvent(
  event: NotificationEvent,
): event is Extract<
  NotificationEvent,
  { type: (typeof ADMIN_NOTIFICATION_EVENTS)[number] }
> {
  return ADMIN_NOTIFICATION_EVENTS.some((type) => type === event.type);
}

function isUserNotificationEvent(
  event: NotificationEvent,
): event is Extract<
  NotificationEvent,
  { type: (typeof USER_NOTIFICATION_EVENTS)[number] }
> {
  return USER_NOTIFICATION_EVENTS.some((type) => type === event.type);
}

function getMatchedWebhookEndpoints(
  config: Awaited<ReturnType<typeof ConfigService.getSystemConfig>>,
  eventType: NotificationWebhookEventType,
) {
  return (
    config?.notification?.webhooks?.filter(
      (endpoint) => endpoint.enabled && endpoint.events.includes(eventType),
    ) ?? []
  );
}

async function createNotificationEventId(event: NotificationEvent) {
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function enqueueEmailNotification(
  context: DbContext,
  event: NotificationEvent,
  eventId: string,
) {
  const emailMessage = createEmailMessageFromNotification(
    event,
    serverEnv(context.env).LOCALE,
  );
  await context.env.QUEUE.send({
    type: "EMAIL",
    data: { ...emailMessage, idempotencyKey: eventId },
  });
}

async function enqueueWebhookNotification(
  context: DbContext & { executionCtx: ExecutionContext },
  event: Extract<NotificationEvent, { type: NotificationWebhookEventType }>,
  config: Awaited<ReturnType<typeof ConfigService.getSystemConfig>>,
  eventId: string,
) {
  const endpoints = getMatchedWebhookEndpoints(config, event.type);

  await Promise.all(
    endpoints.map((endpoint) =>
      context.env.QUEUE.send({
        type: "WEBHOOK",
        data: {
          endpointId: endpoint.id,
          url: endpoint.url,
          secret: endpoint.secret,
          event,
          eventId,
        },
      }),
    ),
  );
}

export async function publishNotificationEvent(
  context: DbContext & { executionCtx: ExecutionContext },
  event: NotificationEvent,
) {
  const parsed = notificationEventSchema.parse(event);
  const eventId = await createNotificationEventId(parsed);
  const config = await ConfigService.getSystemConfig(context);
  const adminEmailEnabled =
    config?.notification?.admin?.channels?.email ?? true;
  const adminWebhookEnabled =
    config?.notification?.admin?.channels?.webhook ?? true;
  const userEmailEnabled = config?.notification?.user?.emailEnabled ?? true;

  if (isUserNotificationEvent(parsed)) {
    if (!userEmailEnabled) {
      return;
    }

    await enqueueEmailNotification(context, parsed, eventId);
    console.log(
      JSON.stringify({
        level: "info",
        message: "Notification published",
        eventType: parsed.type,
        deliveries: { email: true },
      }),
    );
    return;
  }

  if (isAdminNotificationEvent(parsed)) {
    const deliveries: Array<Promise<void>> = [];

    if (adminEmailEnabled) {
      deliveries.push(enqueueEmailNotification(context, parsed, eventId));
    }

    if (adminWebhookEnabled && isNotificationWebhookEventType(parsed)) {
      deliveries.push(
        enqueueWebhookNotification(context, parsed, config, eventId),
      );
    }

    await Promise.all(deliveries);
    console.log(
      JSON.stringify({
        level: "info",
        message: "Notification published",
        eventType: parsed.type,
        eventId,
        deliveries: {
          email: adminEmailEnabled,
          webhook: adminWebhookEnabled,
        },
      }),
    );
    return;
  }

  parsed satisfies never;
}
