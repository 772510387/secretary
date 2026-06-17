import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";
import { brainTaskTypeSchema } from "../brain/index.js";

export const signalSeveritySchema = z.enum(["info", "watch", "warning", "critical"]);

export const cerebellumEventTypeSchema = z.enum([
  "price_surge",
  "price_drop",
  "position_stop_loss",
  "watchlist_price_surge",
  "watchlist_price_drop",
  "watchlist_observe_price_near",
]);

export const cerebellumEventSchema = z
  .object({
    eventId: z.string().trim().min(1),
    eventType: cerebellumEventTypeSchema,
    severity: signalSeveritySchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    occurredAt: isoDateTimeSchema,
    message: z.string().trim().min(1).max(1000),
    source: z.literal("market_sentinel"),
    wakeBrain: z.boolean(),
    cooldownKey: z.string().trim().min(1),
    currentPrice: z.number().finite().nonnegative(),
    previousPrice: z.number().finite().nonnegative().optional(),
    changePct: z.number().finite().optional(),
    threshold: z.number().finite().nonnegative(),
  })
  .strict();

export const cerebellumAlarmTypeSchema = z.enum([
  "data_warmup",
  "overnight_digest",
  "pre_market_plan",
  "call_auction_watch",
  "pre_open_confirmation",
  "morning_review",
  "midday_review",
  "afternoon_risk_scan",
  "late_session_plan",
  "closing_snapshot",
  "closing_review",
  "post_close_review",
  "deep_review",
  "next_day_watchlist",
  "daily_reflection",
  "weekly_review",
  "monthly_review",
  "yearly_review",
]);

export const cerebellumAlarmFrequencySchema = z.enum([
  "weekdays",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

export const cerebellumBeijingTimeSchema = z
  .object({
    timezone: z.literal("Asia/Shanghai"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
    isoLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/),
    year: z.number().int().min(1970).max(9999),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    second: z.number().int().min(0).max(59),
    millisecond: z.number().int().min(0).max(999),
    dayOfWeek: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
    ]),
    minuteOfDay: z.number().int().min(0).max(1439),
  })
  .strict();

export const cerebellumAlarmRuleSchema = z
  .object({
    alarmId: identifierSchema,
    alarmType: cerebellumAlarmTypeSchema,
    jobId: identifierSchema,
    beijingTime: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/),
    timezone: z.literal("Asia/Shanghai").default("Asia/Shanghai"),
    frequency: cerebellumAlarmFrequencySchema,
    priority: z.number().int().positive().max(100),
    brainTaskType: brainTaskTypeSchema,
    weekdaysOnly: z.boolean().default(false),
    dayOfWeek: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
      z.literal(7),
    ]).optional(),
    requireMonthEnd: z.boolean().default(false),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    description: z.string().trim().min(1).max(300),
  })
  .strict();

export const cerebellumContextSourceCategorySchema = z.enum([
  "rules",
  "research",
  "reports",
  "proposals",
  "logs",
  "market",
  "portfolio",
  "config",
]);

export const cerebellumContextSourceSchema = z
  .object({
    sourceId: identifierSchema,
    category: cerebellumContextSourceCategorySchema,
    relativePath: z.string().trim().min(1).max(320),
    title: z.string().trim().min(1).max(240).optional(),
    summary: z.string().trim().min(1).max(1200),
    updatedAt: isoDateTimeSchema.optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const cerebellumSopRequiredInputSchema = z
  .object({
    inputId: identifierSchema,
    category: cerebellumContextSourceCategorySchema,
    relativePath: z.string().trim().min(1).max(320),
    summary: z.string().trim().min(1).max(600),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const cerebellumAlarmSopSchema = z
  .object({
    objective: z.string().trim().min(1).max(800),
    requiredInputs: z.array(cerebellumSopRequiredInputSchema).min(1).max(16),
    allowedActions: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
    forbiddenActions: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
    safetyConstraints: z.array(z.string().trim().min(1).max(240)).min(1).max(24),
  })
  .strict();

export const cerebellumExecutionGuardSchema = z
  .object({
    toolExecutionAllowed: z.literal(false).default(false),
    brokerSubmissionAllowed: z.literal(false).default(false),
    accountWriteAllowed: z.literal(false).default(false),
    liveTradingAllowed: z.literal(false).default(false),
  })
  .strict();

export const cerebellumContextPackageSchema = z
  .object({
    packageId: identifierSchema,
    alarmId: identifierSchema,
    alarmType: cerebellumAlarmTypeSchema,
    jobId: identifierSchema,
    scheduledAt: isoDateTimeSchema,
    beijingTime: cerebellumBeijingTimeSchema,
    brainTaskType: brainTaskTypeSchema,
    summary: z.string().trim().min(1).max(1200),
    sources: z.array(cerebellumContextSourceSchema).max(30).default([]),
    sop: cerebellumAlarmSopSchema,
    metadata: z.record(jsonValueSchema).default({}),
    executionGuard: cerebellumExecutionGuardSchema.default({
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
  })
  .strict();

export const cerebellumAlarmTaskSchema = z
  .object({
    taskId: identifierSchema,
    taskType: z.literal("cerebellum_alarm"),
    alarmId: identifierSchema,
    alarmType: cerebellumAlarmTypeSchema,
    jobId: identifierSchema,
    brainTaskType: brainTaskTypeSchema,
    status: z.literal("planned").default("planned"),
    scheduledAt: isoDateTimeSchema,
    wakeBrain: z.literal(true).default(true),
    contextPackage: cerebellumContextPackageSchema,
    executionGuard: cerebellumExecutionGuardSchema.default({
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
  })
  .strict();

export const cerebellumSilentPatrolStatusSchema = z.enum(["silent", "pending_events"]);

export const cerebellumSilentPatrolTaskSchema = z
  .object({
    taskId: identifierSchema,
    taskType: z.literal("silent_patrol"),
    patrolId: identifierSchema,
    scheduledAt: isoDateTimeSchema,
    beijingTime: cerebellumBeijingTimeSchema,
    intervalMinutes: z.number().int().positive().max(120),
    status: cerebellumSilentPatrolStatusSchema,
    wakeBrain: z.boolean(),
    events: z.array(cerebellumEventSchema).default([]),
    nextCooldownState: z.record(isoDateTimeSchema).default({}),
    metadata: z.record(jsonValueSchema).default({}),
    executionGuard: cerebellumExecutionGuardSchema.default({
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    }),
  })
  .strict();

export type SignalSeverity = z.infer<typeof signalSeveritySchema>;
export type CerebellumEventType = z.infer<typeof cerebellumEventTypeSchema>;
export type CerebellumEvent = z.infer<typeof cerebellumEventSchema>;
export type CerebellumAlarmType = z.infer<typeof cerebellumAlarmTypeSchema>;
export type CerebellumAlarmFrequency = z.infer<typeof cerebellumAlarmFrequencySchema>;
export type CerebellumBeijingTime = z.infer<typeof cerebellumBeijingTimeSchema>;
export type CerebellumAlarmRule = z.infer<typeof cerebellumAlarmRuleSchema>;
export type CerebellumContextSourceCategory = z.infer<
  typeof cerebellumContextSourceCategorySchema
>;
export type CerebellumContextSource = z.infer<typeof cerebellumContextSourceSchema>;
export type CerebellumSopRequiredInput = z.infer<typeof cerebellumSopRequiredInputSchema>;
export type CerebellumAlarmSop = z.infer<typeof cerebellumAlarmSopSchema>;
export type CerebellumExecutionGuard = z.infer<typeof cerebellumExecutionGuardSchema>;
export type CerebellumContextPackage = z.infer<typeof cerebellumContextPackageSchema>;
export type CerebellumAlarmTask = z.infer<typeof cerebellumAlarmTaskSchema>;
export type CerebellumSilentPatrolStatus = z.infer<
  typeof cerebellumSilentPatrolStatusSchema
>;
export type CerebellumSilentPatrolTask = z.infer<typeof cerebellumSilentPatrolTaskSchema>;
