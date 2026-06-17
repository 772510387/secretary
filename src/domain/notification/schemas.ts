import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";

export const notificationSeveritySchema = z.enum([
  "info",
  "watch",
  "warning",
  "critical",
]);

export const notificationSourceTypeSchema = z.enum([
  "cerebellum",
  "risk",
  "research",
  "proposal",
  "system",
  "scheduler",
  "brain",
  "broker",
]);

export const notificationChannelSchema = z.enum([
  "console",
  "file",
  "webhook",
  "wechat",
]);

export const notificationTargetTypeSchema = z.enum([
  "symbol",
  "portfolio",
  "system",
  "proposal",
  "research",
  "memory",
  "account",
]);

export const notificationSourceSchema = z
  .object({
    type: notificationSourceTypeSchema,
    id: identifierSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const notificationTargetSchema = z
  .object({
    type: notificationTargetTypeSchema,
    id: identifierSchema.optional(),
    symbol: stockSymbolSchema.optional(),
    market: stockMarketSchema.optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.type === "symbol" && target.symbol === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbol"],
        message: "symbol target requires symbol",
      });
    }
  });

export const notificationEventSchema = z
  .object({
    eventId: identifierSchema,
    occurredAt: isoDateTimeSchema,
    severity: notificationSeveritySchema,
    source: notificationSourceSchema,
    target: notificationTargetSchema,
    summary: z.string().trim().min(1).max(1000),
    recommendedAction: z.string().trim().min(1).max(500),
    auditEventId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    dedupeKey: z.string().trim().min(1).max(240).optional(),
    cooldownKey: z.string().trim().min(1).max(240).optional(),
    channels: z.array(notificationChannelSchema).min(1).default(["console"]),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const notificationPolicyStateSchema = z
  .object({
    deliveredKeys: z.record(isoDateTimeSchema).default({}),
    cooldownKeys: z.record(isoDateTimeSchema).default({}),
  })
  .strict();

export const notificationDecisionStatusSchema = z.enum([
  "send",
  "skip_duplicate",
  "skip_cooldown",
]);

export const notificationDecisionSchema = z
  .object({
    status: notificationDecisionStatusSchema,
    event: notificationEventSchema,
    reason: z.string().trim().min(1).max(240),
    dedupeKey: z.string().trim().min(1).max(240),
    cooldownKey: z.string().trim().min(1).max(240),
    decidedAt: isoDateTimeSchema,
    nextState: notificationPolicyStateSchema,
  })
  .strict();

export const notificationDeliveryStatusSchema = z.enum([
  "sent",
  "skipped",
  "failed",
]);

export const notificationDeliveryResultSchema = z
  .object({
    eventId: identifierSchema,
    channel: notificationChannelSchema,
    status: notificationDeliveryStatusSchema,
    deliveredAt: isoDateTimeSchema,
    output: z.string().trim().min(1).max(2000).optional(),
    filePath: z.string().trim().min(1).max(500).optional(),
    backupPath: z.string().trim().min(1).max(500).optional(),
    error: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
export type NotificationSourceType = z.infer<typeof notificationSourceTypeSchema>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type NotificationTargetType = z.infer<typeof notificationTargetTypeSchema>;
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
export type NotificationTarget = z.infer<typeof notificationTargetSchema>;
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
export type NotificationPolicyState = z.infer<typeof notificationPolicyStateSchema>;
export type NotificationDecisionStatus = z.infer<typeof notificationDecisionStatusSchema>;
export type NotificationDecision = z.infer<typeof notificationDecisionSchema>;
export type NotificationDeliveryStatus = z.infer<typeof notificationDeliveryStatusSchema>;
export type NotificationDeliveryResult = z.infer<typeof notificationDeliveryResultSchema>;
