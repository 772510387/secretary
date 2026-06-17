import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  redactNotificationEvent,
  type NotificationDeliveryResult,
  type NotificationEvent,
} from "../../domain/notification/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "../storage/index.js";
import type { NotificationNotifier } from "./notifier.js";

export interface FileNotifierOptions {
  filePath: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
}

export class FileNotifier implements NotificationNotifier {
  private readonly filePath: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;

  constructor(options: FileNotifierOptions) {
    this.filePath = path.resolve(options.filePath);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
  }

  notify(eventInput: NotificationEvent): NotificationDeliveryResult {
    const event = notificationEventSchema.parse(eventInput);
    const write = appendNotificationEvent(this.filePath, event, this.writer);

    return notificationDeliveryResultSchema.parse({
      eventId: event.eventId,
      channel: "file",
      status: "sent",
      deliveredAt: this.isoNow(),
      filePath: write.filePath,
      backupPath: write.backupPath,
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new NotificationFileError("FileNotifier now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function appendNotificationEvent(
  filePath: string,
  eventInput: NotificationEvent,
  writer: AtomicFileWriter = new AtomicFileWriter(),
): AtomicWriteResult {
  const parsed = notificationEventSchema.parse(redactNotificationEvent(eventInput));
  const resolvedPath = path.resolve(filePath);
  const previous = existsSync(resolvedPath) ? readFileSync(resolvedPath, "utf8") : "";
  const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";

  return writer.write(resolvedPath, `${previous}${separator}${JSON.stringify(parsed)}\n`);
}

export function createNotificationLogPath(logsDir: string, occurredAt: string): string {
  return path.join(path.resolve(logsDir), `notifications-${occurredAt.slice(0, 10)}.jsonl`);
}

export class NotificationFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationFileError";
  }
}
