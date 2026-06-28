import {
  cerebellumAlarmRuleSchema,
  cerebellumAlarmTaskSchema,
  cerebellumBeijingTimeSchema,
  cerebellumContextPackageSchema,
  cerebellumContextSourceSchema,
  type CerebellumAlarmRule,
  type CerebellumAlarmTask,
  type CerebellumBeijingTime,
  type CerebellumContextPackage,
  type CerebellumContextSource,
} from "./schemas.js";
import { type JsonValue } from "../shared/index.js";
import { buildCerebellumAlarmSop } from "./alarm-sop.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export const FIXED_CEREBELLUM_ALARM_RULES: readonly CerebellumAlarmRule[] = [
  fixedAlarm({
    alarmId: "data-warmup",
    alarmType: "data_warmup",
    beijingTime: "08:00",
    priority: 10,
    brainTaskType: "pre_market_plan",
    description: "08:00 Beijing data warmup task.",
  }),
  fixedAlarm({
    alarmId: "overnight-digest",
    alarmType: "overnight_digest",
    beijingTime: "08:15",
    priority: 11,
    brainTaskType: "pre_market_plan",
    description: "08:15 Beijing overnight news digest task.",
  }),
  fixedAlarm({
    alarmId: "pre-market-plan",
    alarmType: "pre_market_plan",
    beijingTime: "08:30",
    priority: 12,
    brainTaskType: "pre_market_plan",
    description: "08:30 Beijing pre-market planning task.",
  }),
  fixedAlarm({
    alarmId: "call-auction-watch",
    alarmType: "call_auction_watch",
    beijingTime: "09:15",
    priority: 13,
    brainTaskType: "pre_market_plan",
    description: "09:15 Beijing call auction observation task.",
  }),
  fixedAlarm({
    alarmId: "pre-open-confirmation",
    alarmType: "pre_open_confirmation",
    beijingTime: "09:25",
    priority: 14,
    brainTaskType: "pre_market_plan",
    description: "09:25 Beijing pre-open confirmation task.",
  }),
  fixedAlarm({
    alarmId: "morning-review",
    alarmType: "morning_review",
    beijingTime: "10:30",
    priority: 15,
    brainTaskType: "midday_review",
    description: "10:30 Beijing required morning trend review task.",
  }),
  fixedAlarm({
    alarmId: "midday-review",
    alarmType: "midday_review",
    beijingTime: "11:30",
    priority: 16,
    brainTaskType: "midday_review",
    description: "11:30 Beijing midday review task.",
  }),
  fixedAlarm({
    alarmId: "afternoon-risk-scan",
    alarmType: "afternoon_risk_scan",
    beijingTime: "13:30",
    priority: 17,
    brainTaskType: "midday_review",
    description: "13:30 Beijing required afternoon jump-risk scan task.",
  }),
  fixedAlarm({
    alarmId: "late-session-plan",
    alarmType: "late_session_plan",
    beijingTime: "14:30",
    priority: 18,
    brainTaskType: "midday_review",
    description: "14:30 Beijing late-session plan task.",
  }),
  fixedAlarm({
    alarmId: "closing-snapshot",
    alarmType: "closing_snapshot",
    beijingTime: "15:00",
    priority: 19,
    brainTaskType: "closing_review",
    description: "15:00 Beijing closing snapshot task.",
  }),
  fixedAlarm({
    alarmId: "post-close-review",
    alarmType: "post_close_review",
    beijingTime: "15:30",
    priority: 20,
    brainTaskType: "closing_review",
    description: "15:30 Beijing post-close extended review task.",
  }),
  fixedAlarm({
    alarmId: "deep-review",
    alarmType: "deep_review",
    beijingTime: "20:30",
    priority: 21,
    brainTaskType: "daily_reflection",
    description: "20:30 Beijing deep review task.",
  }),
  fixedAlarm({
    alarmId: "next-day-watchlist",
    alarmType: "next_day_watchlist",
    beijingTime: "21:00",
    priority: 22,
    brainTaskType: "daily_reflection",
    description: "21:00 Beijing next-day watchlist preparation task.",
  }),
  fixedAlarm({
    alarmId: "daily-reflection",
    alarmType: "daily_reflection",
    beijingTime: "00:00",
    frequency: "daily",
    priority: 23,
    brainTaskType: "daily_reflection",
    weekdaysOnly: false,
    description: "00:00 Beijing daily reflection task.",
  }),
  fixedAlarm({
    alarmId: "weekly-review",
    alarmType: "weekly_review",
    beijingTime: "10:00",
    frequency: "weekly",
    priority: 24,
    brainTaskType: "daily_reflection",
    weekdaysOnly: false,
    dayOfWeek: 6,
    description: "Saturday 10:00 Beijing weekly review task.",
  }),
  fixedAlarm({
    alarmId: "monthly-review",
    alarmType: "monthly_review",
    beijingTime: "20:00",
    frequency: "monthly",
    priority: 25,
    brainTaskType: "daily_reflection",
    weekdaysOnly: false,
    requireMonthEnd: true,
    description: "Month-end 20:00 Beijing monthly review task.",
  }),
  fixedAlarm({
    alarmId: "yearly-review",
    alarmType: "yearly_review",
    beijingTime: "20:00",
    frequency: "yearly",
    priority: 26,
    brainTaskType: "daily_reflection",
    weekdaysOnly: false,
    month: 12,
    day: 31,
    description: "December 31 20:00 Beijing yearly review task.",
  }),
].map((rule) => cerebellumAlarmRuleSchema.parse(rule));

type FixedAlarmInput = Pick<
  CerebellumAlarmRule,
  "alarmId" | "alarmType" | "beijingTime" | "priority" | "brainTaskType" | "description"
> &
  Partial<Pick<
    CerebellumAlarmRule,
    "frequency" | "weekdaysOnly" | "dayOfWeek" | "requireMonthEnd" | "month" | "day"
  >>;

function fixedAlarm(input: FixedAlarmInput): CerebellumAlarmRule {
  return cerebellumAlarmRuleSchema.parse({
    frequency: "weekdays",
    weekdaysOnly: true,
    requireMonthEnd: false,
    ...input,
    jobId: `cerebellum-${input.alarmId}`,
    timezone: "Asia/Shanghai",
  });
}

export interface GetDueCerebellumAlarmsInput {
  now?: Date | string;
  alarms?: readonly CerebellumAlarmRule[];
}

export interface BuildCerebellumContextPackageInput {
  alarm: CerebellumAlarmRule;
  scheduledAt?: Date | string;
  sources?: readonly unknown[];
  metadata?: Record<string, unknown>;
  summary?: string;
}

export interface BuildCerebellumAlarmTaskInput extends BuildCerebellumContextPackageInput {
  taskIdPrefix?: string;
}

export function getDueCerebellumAlarms(
  input: GetDueCerebellumAlarmsInput = {},
): CerebellumAlarmRule[] {
  const beijingTime = toCerebellumBeijingTime(input.now);
  return (input.alarms ?? FIXED_CEREBELLUM_ALARM_RULES)
    .map((alarm) => cerebellumAlarmRuleSchema.parse(alarm))
    .filter((alarm) => isCerebellumAlarmDueAtBeijingTime(alarm, beijingTime))
    .sort((left, right) => left.priority - right.priority);
}

export function isCerebellumAlarmDue(
  alarmInput: CerebellumAlarmRule,
  now?: Date | string,
): boolean {
  return isCerebellumAlarmDueAtBeijingTime(alarmInput, toCerebellumBeijingTime(now));
}

export function isCerebellumAlarmDueAtBeijingTime(
  alarmInput: CerebellumAlarmRule,
  beijingTimeInput: CerebellumBeijingTime,
): boolean {
  const alarm = cerebellumAlarmRuleSchema.parse(alarmInput);
  const beijingTime = cerebellumBeijingTimeSchema.parse(beijingTimeInput);
  const currentMinute = `${pad2(beijingTime.hour)}:${pad2(beijingTime.minute)}`;

  if (alarm.beijingTime !== currentMinute) {
    return false;
  }

  if (alarm.weekdaysOnly && beijingTime.dayOfWeek > 5) {
    return false;
  }

  if (alarm.dayOfWeek !== undefined && alarm.dayOfWeek !== beijingTime.dayOfWeek) {
    return false;
  }

  if (alarm.requireMonthEnd && !isMonthEnd(beijingTime)) {
    return false;
  }

  if (alarm.month !== undefined && alarm.month !== beijingTime.month) {
    return false;
  }

  if (alarm.day !== undefined && alarm.day !== beijingTime.day) {
    return false;
  }

  return true;
}

export function buildCerebellumAlarmTask(
  input: BuildCerebellumAlarmTaskInput,
): CerebellumAlarmTask {
  const contextPackage = buildCerebellumContextPackage(input);

  return cerebellumAlarmTaskSchema.parse({
    taskId: buildTaskId({
      prefix: input.taskIdPrefix ?? "cerebellum-task",
      alarm: input.alarm,
      beijingTime: contextPackage.beijingTime,
    }),
    taskType: "cerebellum_alarm",
    alarmId: input.alarm.alarmId,
    alarmType: input.alarm.alarmType,
    jobId: input.alarm.jobId,
    brainTaskType: input.alarm.brainTaskType,
    status: "planned",
    scheduledAt: contextPackage.scheduledAt,
    wakeBrain: true,
    contextPackage,
    executionGuard: {
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
  });
}

export function buildCerebellumContextPackage(
  input: BuildCerebellumContextPackageInput,
): CerebellumContextPackage {
  const alarm = cerebellumAlarmRuleSchema.parse(input.alarm);
  const scheduledAt = normalizeDate(input.scheduledAt).toISOString();
  const beijingTime = toCerebellumBeijingTime(scheduledAt);
  const sources = (input.sources ?? []).map(sanitizeContextSource);

  return cerebellumContextPackageSchema.parse({
    packageId: buildPackageId(alarm, beijingTime),
    alarmId: alarm.alarmId,
    alarmType: alarm.alarmType,
    jobId: alarm.jobId,
    scheduledAt,
    beijingTime,
    brainTaskType: alarm.brainTaskType,
    summary:
      input.summary ??
      `${alarm.alarmType} context for ${beijingTime.date} ${alarm.beijingTime} Beijing, ${sources.length} source(s).`,
    sources,
    sop: buildCerebellumAlarmSop(alarm),
    metadata: sanitizeJsonObject({
      ...input.metadata,
      alarmFrequency: alarm.frequency,
      timezone: "Asia/Shanghai",
      liveTrading: false,
      brokerConnected: false,
      directExecutionAllowed: false,
    }),
    executionGuard: {
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
  });
}

export function toCerebellumBeijingTime(value?: Date | string): CerebellumBeijingTime {
  const date = normalizeDate(value);
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const millisecond = shifted.getUTCMilliseconds();
  const rawDayOfWeek = shifted.getUTCDay();
  const dayOfWeek = (rawDayOfWeek === 0 ? 7 : rawDayOfWeek) as CerebellumBeijingTime["dayOfWeek"];
  const datePart = `${year}-${pad2(month)}-${pad2(day)}`;
  const timePart = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;

  return cerebellumBeijingTimeSchema.parse({
    timezone: "Asia/Shanghai",
    date: datePart,
    time: timePart,
    isoLocal: `${datePart}T${timePart}.${pad3(millisecond)}+08:00`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    dayOfWeek,
    minuteOfDay: hour * 60 + minute,
  });
}

function sanitizeContextSource(input: unknown): CerebellumContextSource {
  const object = input as Record<string, unknown>;
  const relativePath = String(object.relativePath ?? "");

  assertSafeContextPath(relativePath);

  return cerebellumContextSourceSchema.parse({
    ...object,
    summary: sanitizeText(String(object.summary ?? "")),
    metadata: sanitizeJsonObject(object.metadata),
  });
}

function sanitizeJsonObject(input: unknown): Record<string, JsonValue> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {};
  }

  return sanitizeJsonValue(input) as Record<string, JsonValue>;
}

function sanitizeJsonValue(input: unknown): JsonValue {
  if (typeof input === "string") {
    return sanitizeText(input);
  }

  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }

  if (typeof input === "boolean" || input === null) {
    return input;
  }

  if (Array.isArray(input)) {
    return input.map(sanitizeJsonValue);
  }

  if (typeof input === "object" && input !== null) {
    const output: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(input)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeJsonValue(value);
    }

    return output;
  }

  return null;
}

function sanitizeText(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|account)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .trim();
}

function assertSafeContextPath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();

  if (
    normalized.includes("/secrets/") ||
    normalized.includes("/secret/") ||
    normalized.includes(".env") ||
    normalized.includes("credential")
  ) {
    throw new CerebellumAlarmError("Context source path must not reference secrets");
  }
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|api_?key|private_?key|credential|account)/i.test(key);
}

function isMonthEnd(beijingTime: CerebellumBeijingTime): boolean {
  return beijingTime.day === daysInMonth(beijingTime.year, beijingTime.month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new CerebellumAlarmError("Invalid cerebellum alarm date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new CerebellumAlarmError(`Invalid cerebellum alarm date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function buildPackageId(alarm: CerebellumAlarmRule, beijingTime: CerebellumBeijingTime): string {
  return [
    "ctx",
    alarm.alarmId,
    beijingTime.date.replace(/-/g, ""),
    alarm.beijingTime.replace(":", ""),
  ].join("-");
}

function buildTaskId(input: {
  prefix: string;
  alarm: CerebellumAlarmRule;
  beijingTime: CerebellumBeijingTime;
}): string {
  return [
    safeIdentifier(input.prefix, 32),
    input.alarm.alarmId,
    input.beijingTime.date.replace(/-/g, ""),
    input.alarm.beijingTime.replace(":", ""),
  ].join("-");
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

export class CerebellumAlarmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebellumAlarmError";
  }
}
