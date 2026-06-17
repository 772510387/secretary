import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  toolRuntimePlanSchema,
  toolRuntimeRequestSchema,
  type ToolRuntimePlan,
  type ToolRuntimeRequest,
} from "../../domain/brain/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../../domain/shared/index.js";

export const webhookEventTypeSchema = z.enum([
  "user_message",
  "market_event",
  "manual_confirm",
  "system_event",
]);

export const webhookSourceTypeSchema = z.enum([
  "chat",
  "alert",
  "scheduler",
  "manual",
  "system",
  "test",
]);

export const webhookAuthSchema = z
  .object({
    scheme: z.literal("bearer").default("bearer"),
    token: z.string().trim().min(8).max(512),
    tokenId: identifierSchema.optional(),
  })
  .strict();

export const webhookSourceSchema = z
  .object({
    sourceType: webhookSourceTypeSchema,
    sourceId: identifierSchema,
    operatorId: identifierSchema.optional(),
  })
  .strict();

const webhookBaseRequestSchema = z
  .object({
    requestId: identifierSchema,
    occurredAt: isoDateTimeSchema.optional(),
    source: webhookSourceSchema,
    auth: webhookAuthSchema,
    toolRequests: z.array(toolRuntimeRequestSchema).max(10).default([]),
  })
  .strict();

export const webhookUserMessagePayloadSchema = z
  .object({
    message: z.string().trim().min(1).max(2000),
    locale: z.string().trim().min(2).max(16).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const webhookMarketEventPayloadSchema = z
  .object({
    eventId: identifierSchema.optional(),
    severity: z.enum(["info", "watch", "warning", "critical"]).default("warning"),
    summary: z.string().trim().min(1).max(1000),
    symbol: stockSymbolSchema.optional(),
    market: stockMarketSchema.optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const webhookManualConfirmPayloadSchema = z
  .object({
    proposalId: identifierSchema,
    decision: z.enum(["approved", "rejected"]),
    reviewerId: identifierSchema.optional(),
    note: z.string().trim().min(1).max(1000).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const webhookSystemEventPayloadSchema = z
  .object({
    eventName: identifierSchema,
    severity: z.enum(["info", "warning", "critical"]).default("info"),
    summary: z.string().trim().min(1).max(1000),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const webhookUserMessageRequestSchema = webhookBaseRequestSchema.extend({
  eventType: z.literal("user_message"),
  payload: webhookUserMessagePayloadSchema,
});

export const webhookMarketEventRequestSchema = webhookBaseRequestSchema.extend({
  eventType: z.literal("market_event"),
  payload: webhookMarketEventPayloadSchema,
});

export const webhookManualConfirmRequestSchema = webhookBaseRequestSchema.extend({
  eventType: z.literal("manual_confirm"),
  payload: webhookManualConfirmPayloadSchema,
});

export const webhookSystemEventRequestSchema = webhookBaseRequestSchema.extend({
  eventType: z.literal("system_event"),
  payload: webhookSystemEventPayloadSchema,
});

export const webhookRequestSchema = z.discriminatedUnion("eventType", [
  webhookUserMessageRequestSchema,
  webhookMarketEventRequestSchema,
  webhookManualConfirmRequestSchema,
  webhookSystemEventRequestSchema,
]);

export const webhookPlannedActionTypeSchema = z.enum([
  "create_task",
  "create_report",
  "create_proposal",
  "create_notification",
]);

export const webhookExecutionGuardSchema = z
  .object({
    toolExecutionAllowed: z.literal(false).default(false),
    brokerSubmissionAllowed: z.literal(false).default(false),
    accountWriteAllowed: z.literal(false).default(false),
    liveTradingAllowed: z.literal(false).default(false),
  })
  .strict();

export const webhookPlannedActionSchema = z
  .object({
    actionId: identifierSchema,
    actionType: webhookPlannedActionTypeSchema,
    target: z.string().trim().min(1).max(120),
    referenceId: identifierSchema.optional(),
    metadata: z.record(jsonValueSchema).default({}),
    executionGuard: webhookExecutionGuardSchema.default({
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
  })
  .strict();

export const webhookHandlingStatusSchema = z.enum([
  "accepted",
  "rejected",
  "unauthorized",
  "rate_limited",
  "skipped_duplicate",
]);

export const webhookAccessAuditSourceSchema = z
  .object({
    sourceType: z.union([webhookSourceTypeSchema, z.literal("unknown")]),
    sourceId: z.union([identifierSchema, z.literal("unknown")]),
    operatorId: identifierSchema.optional(),
  })
  .strict();

export const webhookAccessAuditSchema = z
  .object({
    auditId: identifierSchema,
    requestId: identifierSchema,
    source: webhookAccessAuditSourceSchema,
    eventType: z.union([webhookEventTypeSchema, z.literal("unknown")]),
    result: webhookHandlingStatusSchema,
    occurredAt: isoDateTimeSchema,
    duplicate: z.boolean().default(false),
    rateLimited: z.boolean().default(false),
    rejectionReasons: z.array(z.string().trim().min(1).max(160)).default([]),
    tokenLogged: z.literal(false).default(false),
    secretHeaderLogged: z.literal(false).default(false),
    payloadLogged: z.literal(false).default(false),
    sensitiveBodyLogged: z.literal(false).default(false),
  })
  .strict();

export const webhookRateLimitBucketSchema = z
  .object({
    windowStartedAt: isoDateTimeSchema,
    count: z.number().int().nonnegative(),
  })
  .strict();

export const webhookSecurityStateSchema = z
  .object({
    recentRequestIds: z.record(isoDateTimeSchema).default({}),
    rateLimitBuckets: z.record(webhookRateLimitBucketSchema).default({}),
  })
  .strict();

export const webhookHandlingResultSchema = z
  .object({
    status: webhookHandlingStatusSchema,
    requestId: identifierSchema,
    eventType: webhookEventTypeSchema.optional(),
    occurredAt: isoDateTimeSchema,
    plannedActions: z.array(webhookPlannedActionSchema).default([]),
    toolPlans: z.array(toolRuntimePlanSchema).default([]),
    rejectionReasons: z.array(z.string().trim().min(1).max(160)).default([]),
    auditEvent: auditEventSchema,
    accessAudit: webhookAccessAuditSchema,
    nextSecurityState: webhookSecurityStateSchema,
  })
  .strict();

export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
export type WebhookSourceType = z.infer<typeof webhookSourceTypeSchema>;
export type WebhookAuth = z.infer<typeof webhookAuthSchema>;
export type WebhookSource = z.infer<typeof webhookSourceSchema>;
export type WebhookUserMessagePayload = z.infer<typeof webhookUserMessagePayloadSchema>;
export type WebhookMarketEventPayload = z.infer<typeof webhookMarketEventPayloadSchema>;
export type WebhookManualConfirmPayload = z.infer<typeof webhookManualConfirmPayloadSchema>;
export type WebhookSystemEventPayload = z.infer<typeof webhookSystemEventPayloadSchema>;
export type WebhookRequest = z.infer<typeof webhookRequestSchema>;
export type WebhookPlannedActionType = z.infer<typeof webhookPlannedActionTypeSchema>;
export type WebhookExecutionGuard = z.infer<typeof webhookExecutionGuardSchema>;
export type WebhookPlannedAction = z.infer<typeof webhookPlannedActionSchema>;
export type WebhookHandlingStatus = z.infer<typeof webhookHandlingStatusSchema>;
export type WebhookAccessAuditSource = z.infer<typeof webhookAccessAuditSourceSchema>;
export type WebhookAccessAudit = z.infer<typeof webhookAccessAuditSchema>;
export type WebhookRateLimitBucket = z.infer<typeof webhookRateLimitBucketSchema>;
export type WebhookSecurityState = z.infer<typeof webhookSecurityStateSchema>;
export type WebhookHandlingResult = z.infer<typeof webhookHandlingResultSchema>;
export type { AuditEvent, ToolRuntimePlan, ToolRuntimeRequest };
