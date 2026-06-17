import type {
  NotificationDeliveryResult,
  NotificationEvent,
} from "../../domain/notification/index.js";

export interface NotificationNotifier {
  notify(event: NotificationEvent): NotificationDeliveryResult;
}

export interface ExternalNotificationNotifier {
  readonly channel: "webhook" | "wechat";
  notify(event: NotificationEvent): Promise<NotificationDeliveryResult>;
}
