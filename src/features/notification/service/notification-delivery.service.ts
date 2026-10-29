import { getDb } from "@/lib/db";
import type {
  NotificationDeliveryChannel,
  NotificationDeliveryStatus,
} from "@/lib/db/schema";
import * as NotificationDeliveryRepo from "@/features/notification/data/notification-delivery.data";

export async function recordNotificationDelivery(
  env: Env,
  input: {
    eventId: string;
    channel: NotificationDeliveryChannel;
    status: NotificationDeliveryStatus;
    target?: string;
    error?: string | null;
  },
): Promise<void> {
  try {
    await NotificationDeliveryRepo.upsertNotificationDelivery(getDb(env), input);
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "notification delivery status persist failed",
        eventId: input.eventId,
        channel: input.channel,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

export async function listNotificationDeliveryLogs(
  context: DbContext,
  input: {
    limit?: number;
    offset?: number;
    status?: NotificationDeliveryStatus;
  } = {},
) {
  return await NotificationDeliveryRepo.listNotificationDeliveries(
    context.db,
    input,
  );
}
