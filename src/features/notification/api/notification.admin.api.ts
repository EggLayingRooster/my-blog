import { createServerFn } from "@tanstack/react-start";
import { GetNotificationDeliveriesInputSchema } from "@/features/notification/notification.schema";
import { listNotificationDeliveryLogs } from "@/features/notification/service/notification-delivery.service";
import { adminMiddleware } from "@/lib/middlewares";

export const getNotificationDeliveriesFn = createServerFn()
  .middleware([adminMiddleware])
  .inputValidator(GetNotificationDeliveriesInputSchema)
  .handler(({ data, context }) =>
    listNotificationDeliveryLogs(context, data),
  );
