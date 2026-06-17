import {
  notificationEventSchema,
  type NotificationEvent,
} from "./schemas.js";
import type { JsonValue } from "../shared/index.js";

export function redactNotificationEvent(eventInput: NotificationEvent): NotificationEvent {
  const event = notificationEventSchema.parse(eventInput);

  return notificationEventSchema.parse({
    ...event,
    source: {
      ...event.source,
      name: event.source.name ? redactNotificationText(event.source.name) : undefined,
    },
    target: {
      ...event.target,
      name: event.target.name ? redactNotificationText(event.target.name) : undefined,
    },
    summary: redactNotificationText(event.summary),
    recommendedAction: redactNotificationText(event.recommendedAction),
    metadata: redactNotificationJsonObject(event.metadata),
  });
}

export function redactNotificationText(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
}

function redactNotificationJsonObject(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = isSensitiveKey(key) ? "[redacted]" : redactNotificationJsonValue(value);
  }

  return output;
}

function redactNotificationJsonValue(input: JsonValue): JsonValue {
  if (typeof input === "string") {
    return redactNotificationText(input);
  }

  if (Array.isArray(input)) {
    return input.map(redactNotificationJsonValue);
  }

  if (typeof input === "object" && input !== null) {
    const output: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(input)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : redactNotificationJsonValue(value);
    }

    return output;
  }

  return input;
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|api_?key|private_?key|credential)/i.test(key);
}
