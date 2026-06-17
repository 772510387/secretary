import type {
  QuoteSnapshot,
  WatchlistEntryInput,
} from "../market/index.js";
import type { Position } from "../portfolio/index.js";
import type { JsonValue } from "../shared/index.js";
import { toCerebellumBeijingTime } from "./alarm-matrix.js";
import {
  checkMarketSentinel,
  type MarketSentinelOptions,
} from "./market-sentinel.js";
import {
  cerebellumSilentPatrolTaskSchema,
  type CerebellumBeijingTime,
  type CerebellumEvent,
  type CerebellumSilentPatrolTask,
} from "./schemas.js";

export const DEFAULT_SILENT_PATROL_INTERVAL_MINUTES = 10;
export const DEFAULT_SILENT_PATROL_ID = "silent-patrol-10m";

export interface SilentPatrolSession {
  startMinute: number;
  endMinute: number;
}

export const DEFAULT_SILENT_PATROL_SESSIONS: readonly SilentPatrolSession[] = [
  { startMinute: 9 * 60 + 30, endMinute: 11 * 60 + 30 },
  { startMinute: 13 * 60, endMinute: 15 * 60 },
];

export interface SilentPatrolOptions {
  patrolId?: string;
  intervalMinutes?: number;
  sessions?: readonly SilentPatrolSession[];
  weekdaysOnly?: boolean;
  sentinel?: MarketSentinelOptions;
}

export interface BuildSilentPatrolTaskInput {
  now?: Date | string;
  quotes?: readonly QuoteSnapshot[];
  positions?: readonly Position[];
  previousQuotes?: readonly QuoteSnapshot[];
  watchlistEntries?: readonly WatchlistEntryInput[];
  cooldownState?: Record<string, string>;
  metadata?: Record<string, unknown>;
  options?: SilentPatrolOptions;
}

export type SilentPatrolSkipReason = "outside_session" | "not_on_interval";

export type BuildSilentPatrolTaskResult =
  | {
      due: true;
      scheduledAt: string;
      beijingTime: CerebellumBeijingTime;
      task: CerebellumSilentPatrolTask;
      events: CerebellumEvent[];
      nextCooldownState: Record<string, string>;
      metadata: Record<string, JsonValue>;
    }
  | {
      due: false;
      reason: SilentPatrolSkipReason;
      scheduledAt: string;
      beijingTime: CerebellumBeijingTime;
      events: [];
      nextCooldownState: Record<string, string>;
      metadata: Record<string, JsonValue>;
    };

interface NormalizedSilentPatrolOptions {
  patrolId: string;
  intervalMinutes: number;
  sessions: readonly SilentPatrolSession[];
  weekdaysOnly: boolean;
  sentinel?: MarketSentinelOptions;
}

export function isSilentPatrolDue(
  now?: Date | string,
  options: SilentPatrolOptions = {},
): boolean {
  const scheduledAt = normalizeDate(now);
  const beijingTime = toCerebellumBeijingTime(scheduledAt);
  const normalized = normalizeOptions(options);

  return (
    isWithinPatrolSession(beijingTime, normalized) &&
    isOnPatrolInterval(beijingTime, normalized.intervalMinutes)
  );
}

export function buildSilentPatrolTask(
  input: BuildSilentPatrolTaskInput = {},
): BuildSilentPatrolTaskResult {
  const scheduledAtDate = normalizeDate(input.now);
  const scheduledAt = scheduledAtDate.toISOString();
  const beijingTime = toCerebellumBeijingTime(scheduledAtDate);
  const options = normalizeOptions(input.options);
  const baseMetadata = buildBaseMetadata(input.metadata, options);
  const nextCooldownState = { ...(input.cooldownState ?? {}) };

  if (!isWithinPatrolSession(beijingTime, options)) {
    return {
      due: false,
      reason: "outside_session",
      scheduledAt,
      beijingTime,
      events: [],
      nextCooldownState,
      metadata: {
        ...baseMetadata,
        status: "skipped",
        skipReason: "outside_session",
        eventCount: 0,
      },
    };
  }

  if (!isOnPatrolInterval(beijingTime, options.intervalMinutes)) {
    return {
      due: false,
      reason: "not_on_interval",
      scheduledAt,
      beijingTime,
      events: [],
      nextCooldownState,
      metadata: {
        ...baseMetadata,
        status: "skipped",
        skipReason: "not_on_interval",
        eventCount: 0,
      },
    };
  }

  const sentinelResult = checkMarketSentinel({
    now: scheduledAt,
    quotes: [...(input.quotes ?? [])],
    positions: [...(input.positions ?? [])],
    previousQuotes: [...(input.previousQuotes ?? [])],
    watchlistEntries: [...(input.watchlistEntries ?? [])],
    cooldownState: nextCooldownState,
    options: options.sentinel,
  });
  const status = sentinelResult.events.length > 0 ? "pending_events" : "silent";
  const metadata = {
    ...baseMetadata,
    status,
    checkedAt: sentinelResult.checkedAt,
    eventCount: sentinelResult.events.length,
    pendingEventIds: sentinelResult.events.map((event) => event.eventId),
    auditEventIds: sentinelResult.auditEvents.map((event) => event.eventId),
    silent: sentinelResult.events.length === 0,
  };
  const task = cerebellumSilentPatrolTaskSchema.parse({
    taskId: buildTaskId(options, beijingTime),
    taskType: "silent_patrol",
    patrolId: options.patrolId,
    scheduledAt,
    beijingTime,
    intervalMinutes: options.intervalMinutes,
    status,
    wakeBrain: sentinelResult.events.length > 0,
    events: sentinelResult.events,
    nextCooldownState: sentinelResult.nextCooldownState,
    metadata,
    executionGuard: {
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
  });

  return {
    due: true,
    scheduledAt,
    beijingTime,
    task,
    events: sentinelResult.events,
    nextCooldownState: sentinelResult.nextCooldownState,
    metadata,
  };
}

function normalizeOptions(
  options: SilentPatrolOptions = {},
): NormalizedSilentPatrolOptions {
  const intervalMinutes = options.intervalMinutes ?? DEFAULT_SILENT_PATROL_INTERVAL_MINUTES;
  const sessions = options.sessions ?? DEFAULT_SILENT_PATROL_SESSIONS;

  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0 || intervalMinutes > 120) {
    throw new SilentPatrolError("intervalMinutes must be an integer between 1 and 120");
  }

  if (sessions.length === 0) {
    throw new SilentPatrolError("At least one silent patrol session is required");
  }

  for (const session of sessions) {
    assertMinuteOfDay(session.startMinute, "session.startMinute");
    assertMinuteOfDay(session.endMinute, "session.endMinute");

    if (session.startMinute >= session.endMinute) {
      throw new SilentPatrolError("Silent patrol session start must be before end");
    }
  }

  return {
    patrolId: safeIdentifier(options.patrolId ?? DEFAULT_SILENT_PATROL_ID, 80),
    intervalMinutes,
    sessions,
    weekdaysOnly: options.weekdaysOnly ?? true,
    sentinel: options.sentinel,
  };
}

function isWithinPatrolSession(
  beijingTime: CerebellumBeijingTime,
  options: NormalizedSilentPatrolOptions,
): boolean {
  if (options.weekdaysOnly && beijingTime.dayOfWeek > 5) {
    return false;
  }

  return options.sessions.some(
    (session) =>
      beijingTime.minuteOfDay >= session.startMinute &&
      beijingTime.minuteOfDay < session.endMinute,
  );
}

function isOnPatrolInterval(
  beijingTime: CerebellumBeijingTime,
  intervalMinutes: number,
): boolean {
  return beijingTime.second === 0 && beijingTime.minuteOfDay % intervalMinutes === 0;
}

function buildBaseMetadata(
  metadata: Record<string, unknown> | undefined,
  options: NormalizedSilentPatrolOptions,
): Record<string, JsonValue> {
  return sanitizeJsonObject({
    ...metadata,
    patrolId: options.patrolId,
    intervalMinutes: options.intervalMinutes,
    timezone: "Asia/Shanghai",
    liveTrading: false,
    brokerConnected: false,
    directExecutionAllowed: false,
    brainProviderCalled: false,
  });
}

function buildTaskId(
  options: NormalizedSilentPatrolOptions,
  beijingTime: CerebellumBeijingTime,
): string {
  return [
    options.patrolId,
    beijingTime.date.replace(/-/g, ""),
    `${pad2(beijingTime.hour)}${pad2(beijingTime.minute)}`,
  ].join("-");
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new SilentPatrolError("Invalid silent patrol date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new SilentPatrolError(`Invalid silent patrol date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function assertMinuteOfDay(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 24 * 60) {
    throw new SilentPatrolError(`${name} must be a minute of day`);
  }
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
  const sanitized = input
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|account)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .trim();

  return sanitized.length > 500 ? `${sanitized.slice(0, 500)}...[truncated]` : sanitized;
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|api_?key|private_?key|credential|account)/i.test(key);
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : DEFAULT_SILENT_PATROL_ID;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export class SilentPatrolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SilentPatrolError";
  }
}
