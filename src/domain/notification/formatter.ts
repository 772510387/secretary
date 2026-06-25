import {
  type NotificationEvent,
} from "./schemas.js";
import { beijingDateTimeLabel } from "../shared/index.js";
import { redactNotificationEvent } from "./redaction.js";

export function formatNotificationForConsole(eventInput: NotificationEvent): string {
  const event = redactNotificationEvent(eventInput);
  const target = formatTarget(event);
  const audit = event.auditEventId ? ` audit=${event.auditEventId}` : "";
  const correlation = event.correlationId ? ` correlation=${event.correlationId}` : "";

  return [
    `[${beijingDateTimeLabel(event.occurredAt)}]`,
    event.severity.toUpperCase(),
    `source=${formatSource(event)}`,
    `target=${target}`,
    `summary=${event.summary}`,
    `action=${event.recommendedAction}`,
    `${audit}${correlation}`.trim(),
  ]
    .filter(Boolean)
    .join(" | ");
}

function formatSource(event: NotificationEvent): string {
  return event.source.id ? `${event.source.type}:${event.source.id}` : event.source.type;
}

function formatTarget(event: NotificationEvent): string {
  if (event.target.symbol) {
    const market = event.target.market ? `${event.target.market}:` : "";
    const name = event.target.name ? `:${event.target.name}` : "";
    return `${market}${event.target.symbol}${name}`;
  }

  return event.target.id ? `${event.target.type}:${event.target.id}` : event.target.type;
}
