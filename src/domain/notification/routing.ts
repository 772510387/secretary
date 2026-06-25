import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../audit/index.js";
import type { JsonValue } from "../shared/index.js";
import {
  notificationChannelSchema,
  notificationDecisionSchema,
  notificationDecisionStatusSchema,
  notificationEventSchema,
  notificationPolicyStateSchema,
  type NotificationChannel,
  type NotificationDecision,
  type NotificationEvent,
  type NotificationPolicyState,
} from "./schemas.js";
import {
  evaluateNotificationPolicy,
  type EvaluateNotificationPolicyOptions,
} from "./policy.js";
import { redactNotificationEvent } from "./redaction.js";

export const notificationExternalChannelSchema = z.enum(["webhook", "wechat", "feishu"]);

export const notificationSkippedChannelSchema = z
  .object({
    channel: notificationChannelSchema,
    reason: z.enum(["external_disabled", "policy_skipped", "fallback_local_required"]),
  })
  .strict();

export const notificationRouteConfigSchema = z
  .object({
    info: z.array(notificationChannelSchema).min(1).max(4).default(["console"]),
    watch: z.array(notificationChannelSchema).min(1).max(4).default(["console", "file"]),
    warning: z.array(notificationChannelSchema).min(1).max(4).default(["console", "file"]),
    critical: z.array(notificationChannelSchema).min(2).max(4).default(["console", "file"]),
    externalChannelsEnabled: z.array(notificationExternalChannelSchema).default([]),
  })
  .strict();

export const notificationRoutePlanSchema = z
  .object({
    status: notificationDecisionStatusSchema,
    event: notificationEventSchema,
    decision: notificationDecisionSchema,
    channels: z.array(notificationChannelSchema).default([]),
    skippedChannels: z.array(notificationSkippedChannelSchema).default([]),
    auditEvent: auditEventSchema.optional(),
    plannedAt: z.string().datetime(),
    nextState: notificationPolicyStateSchema,
  })
  .strict();

export type NotificationExternalChannel = z.infer<typeof notificationExternalChannelSchema>;
export type NotificationSkippedChannel = z.infer<typeof notificationSkippedChannelSchema>;
export type NotificationRouteConfig = z.infer<typeof notificationRouteConfigSchema>;
export type NotificationRoutePlan = z.infer<typeof notificationRoutePlanSchema>;

export interface PlanNotificationRouteOptions extends EvaluateNotificationPolicyOptions {
  routeConfig?: Partial<NotificationRouteConfig>;
}

const localFallbackChannels = ["console", "file"] as const satisfies readonly NotificationChannel[];

export function planNotificationRoute(
  eventInput: NotificationEvent,
  stateInput: Partial<NotificationPolicyState> = {},
  options: PlanNotificationRouteOptions = {},
): NotificationRoutePlan {
  const event = redactNotificationEvent(notificationEventSchema.parse(eventInput));
  const config = notificationRouteConfigSchema.parse(options.routeConfig ?? {});
  const decision = evaluateNotificationPolicy(event, stateInput, options);

  if (decision.status !== "send") {
    return notificationRoutePlanSchema.parse({
      status: decision.status,
      event,
      decision,
      channels: [],
      skippedChannels: configuredChannelsForSeverity(event, config).map((channel) => ({
        channel,
        reason: "policy_skipped",
      })),
      plannedAt: decision.decidedAt,
      nextState: decision.nextState,
    });
  }

  const route = resolveRouteChannels(event, config);
  const auditEvent = event.severity === "critical"
    ? buildCriticalNotificationAuditEvent(event, route.channels, decision.decidedAt)
    : undefined;

  return notificationRoutePlanSchema.parse({
    status: "send",
    event: {
      ...event,
      channels: route.channels,
      auditEventId: auditEvent?.eventId ?? event.auditEventId,
    },
    decision,
    channels: route.channels,
    skippedChannels: route.skippedChannels,
    auditEvent,
    plannedAt: decision.decidedAt,
    nextState: decision.nextState,
  });
}

function resolveRouteChannels(
  event: NotificationEvent,
  config: NotificationRouteConfig,
): {
  channels: NotificationChannel[];
  skippedChannels: NotificationSkippedChannel[];
} {
  const enabledExternal = new Set(config.externalChannelsEnabled);
  const channels: NotificationChannel[] = [];
  const skippedChannels: NotificationSkippedChannel[] = [];

  for (const channel of uniqueChannels(configuredChannelsForSeverity(event, config))) {
    if (isExternalChannel(channel) && !enabledExternal.has(channel)) {
      skippedChannels.push({
        channel,
        reason: "external_disabled",
      });
      continue;
    }

    channels.push(channel);
  }

  if (event.severity === "critical") {
    for (const fallback of localFallbackChannels) {
      if (!channels.includes(fallback)) {
        channels.push(fallback);
        skippedChannels.push({
          channel: fallback,
          reason: "fallback_local_required",
        });
      }
    }
  }

  if (channels.length === 0) {
    channels.push("console");
    skippedChannels.push({
      channel: "console",
      reason: "fallback_local_required",
    });
  }

  return {
    channels,
    skippedChannels,
  };
}

function configuredChannelsForSeverity(
  event: NotificationEvent,
  config: NotificationRouteConfig,
): NotificationChannel[] {
  return config[event.severity];
}

function buildCriticalNotificationAuditEvent(
  eventInput: NotificationEvent,
  channels: readonly NotificationChannel[],
  occurredAt: string,
): AuditEvent {
  const event = redactNotificationEvent(eventInput);

  return auditEventSchema.parse({
    eventId: safeIdentifier(`audit-notification-critical-${event.eventId}`, 128),
    occurredAt,
    actor: {
      type: "system",
      id: "notification-router",
    },
    action: "notify",
    subject: {
      type: "risk",
      id: "critical-notification",
    },
    severity: "critical",
    result: "success",
    message: `Critical notification routed for ${event.eventId}`,
    correlationId: event.correlationId ?? event.eventId,
    causationId: event.auditEventId,
    metadata: sanitizeAuditMetadata({
      notificationEventId: event.eventId,
      sourceType: event.source.type,
      sourceId: event.source.id ?? null,
      targetType: event.target.type,
      symbol: event.target.symbol ?? null,
      market: event.target.market ?? null,
      channels: [...channels],
      externalChannels: channels.filter(isExternalChannel),
      summaryLength: event.summary.length,
      recommendedActionLength: event.recommendedAction.length,
      criticalAuditRequired: true,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
  });
}

function isExternalChannel(channel: NotificationChannel): channel is NotificationExternalChannel {
  return channel === "webhook" || channel === "wechat";
}

function uniqueChannels(channels: readonly NotificationChannel[]): NotificationChannel[] {
  return [...new Set(channels)];
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "notification-id";
}

function sanitizeAuditMetadata(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(input)) {
    output[key] = sanitizeAuditValue(value);
  }

  return output;
}

function sanitizeAuditValue(input: JsonValue): JsonValue {
  if (typeof input === "string") {
    return input
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
      .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeAuditValue);
  }

  if (typeof input === "object" && input !== null) {
    return sanitizeAuditMetadata(input);
  }

  return input;
}
