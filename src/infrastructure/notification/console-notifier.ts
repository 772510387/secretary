import {
  formatNotificationForConsole,
  notificationDeliveryResultSchema,
  notificationEventSchema,
  type NotificationDeliveryResult,
  type NotificationEvent,
} from "../../domain/notification/index.js";
import type { NotificationNotifier } from "./notifier.js";

export interface ConsoleNotifierOptions {
  sink?: (line: string) => void;
  now?: () => Date;
}

export class ConsoleNotifier implements NotificationNotifier {
  private readonly sink: (line: string) => void;
  private readonly now: () => Date;

  constructor(options: ConsoleNotifierOptions = {}) {
    this.sink = options.sink ?? ((line) => console.log(line));
    this.now = options.now ?? (() => new Date());
  }

  notify(eventInput: NotificationEvent): NotificationDeliveryResult {
    const event = notificationEventSchema.parse(eventInput);
    const output = formatNotificationForConsole(event);
    this.sink(output);

    return notificationDeliveryResultSchema.parse({
      eventId: event.eventId,
      channel: "console",
      status: "sent",
      deliveredAt: this.isoNow(),
      output,
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new NotificationNotifierError("ConsoleNotifier now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export class NotificationNotifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationNotifierError";
  }
}
