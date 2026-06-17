import {
  notificationDecisionSchema,
  notificationEventSchema,
  notificationPolicyStateSchema,
  type NotificationDecision,
  type NotificationEvent,
  type NotificationPolicyState,
} from "./schemas.js";

export interface EvaluateNotificationPolicyOptions {
  now?: Date | string;
  dedupeWindowMs?: number;
  cooldownMs?: number;
  criticalBypassesCooldown?: boolean;
}

export function evaluateNotificationPolicy(
  eventInput: NotificationEvent,
  stateInput: Partial<NotificationPolicyState> = {},
  options: EvaluateNotificationPolicyOptions = {},
): NotificationDecision {
  const event = notificationEventSchema.parse(eventInput);
  const state = notificationPolicyStateSchema.parse(stateInput);
  const decidedAt = normalizeDate(options.now ?? event.occurredAt).toISOString();
  const dedupeWindowMs = options.dedupeWindowMs ?? 300_000;
  const cooldownMs = options.cooldownMs ?? 600_000;
  const criticalBypassesCooldown = options.criticalBypassesCooldown ?? true;
  const dedupeKey = buildNotificationDedupeKey(event);
  const cooldownKey = buildNotificationCooldownKey(event);

  assertNonNegativeFinite(dedupeWindowMs, "dedupeWindowMs");
  assertNonNegativeFinite(cooldownMs, "cooldownMs");

  const duplicateAt = state.deliveredKeys[dedupeKey];

  if (duplicateAt && isWithinWindow(duplicateAt, decidedAt, dedupeWindowMs)) {
    return notificationDecisionSchema.parse({
      status: "skip_duplicate",
      event,
      reason: "notification duplicate inside dedupe window",
      dedupeKey,
      cooldownKey,
      decidedAt,
      nextState: state,
    });
  }

  const cooldownAt = state.cooldownKeys[cooldownKey];

  if (
    cooldownAt &&
    event.severity !== "critical" &&
    isWithinWindow(cooldownAt, decidedAt, cooldownMs)
  ) {
    return notificationDecisionSchema.parse({
      status: "skip_cooldown",
      event,
      reason: "notification suppressed by cooldown",
      dedupeKey,
      cooldownKey,
      decidedAt,
      nextState: state,
    });
  }

  if (
    cooldownAt &&
    event.severity === "critical" &&
    !criticalBypassesCooldown &&
    isWithinWindow(cooldownAt, decidedAt, cooldownMs)
  ) {
    return notificationDecisionSchema.parse({
      status: "skip_cooldown",
      event,
      reason: "critical notification suppressed by configured cooldown",
      dedupeKey,
      cooldownKey,
      decidedAt,
      nextState: state,
    });
  }

  return notificationDecisionSchema.parse({
    status: "send",
    event,
    reason: "notification accepted",
    dedupeKey,
    cooldownKey,
    decidedAt,
    nextState: {
      deliveredKeys: {
        ...state.deliveredKeys,
        [dedupeKey]: decidedAt,
      },
      cooldownKeys: {
        ...state.cooldownKeys,
        [cooldownKey]: decidedAt,
      },
    },
  });
}

export function buildNotificationDedupeKey(eventInput: NotificationEvent): string {
  const event = notificationEventSchema.parse(eventInput);
  return event.dedupeKey ?? [
    event.source.type,
    event.source.id ?? "source",
    event.severity,
    targetKey(event),
    event.summary,
  ].join(":");
}

export function buildNotificationCooldownKey(eventInput: NotificationEvent): string {
  const event = notificationEventSchema.parse(eventInput);
  return event.cooldownKey ?? [
    event.source.type,
    event.target.type,
    targetKey(event),
  ].join(":");
}

function targetKey(event: NotificationEvent): string {
  if (event.target.symbol) {
    return `${event.target.market ?? "A"}:${event.target.symbol}`;
  }

  return event.target.id ?? event.target.type;
}

function isWithinWindow(previousAt: string, currentAt: string, windowMs: number): boolean {
  const elapsedMs = Date.parse(currentAt) - Date.parse(previousAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < windowMs;
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new NotificationPolicyError(`${name} must be a non-negative finite number`);
  }
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new NotificationPolicyError("Invalid notification policy date");
    }

    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new NotificationPolicyError(`Invalid notification policy date: ${value}`);
  }

  return parsed;
}

export class NotificationPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationPolicyError";
  }
}
