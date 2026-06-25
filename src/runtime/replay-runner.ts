import {
  FIXED_CEREBELLUM_ALARM_RULES,
  isCerebellumAlarmDueAtBeijingTime,
  toCerebellumBeijingTime,
  type CerebellumAlarmRule,
} from "../domain/cerebellum/index.js";
import type { Account, Position } from "../domain/portfolio/index.js";
import { buildReplaySnapshot, AsOfMarketReader } from "../app/index.js";
import type { HistoryProvider } from "../infrastructure/providers/index.js";
import { SimulatedClock } from "../infrastructure/scheduler/index.js";
import { PortfolioSnapshotMemoryStore } from "../infrastructure/storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The same trading day's daily bar is treated as settled only from this Beijing
 * minute onward (15:30, the post-close-review node). Earlier nodes — including the
 * 15:00 closing-snapshot and any intraday node — value at the PRIOR close. This is
 * the deliberate, conservative no-look-ahead boundary (an A-share EOD bar is not
 * final at 15:00:00 sharp). Midnight (00:00) nodes are naturally pre-close → prior day.
 */
const SAME_DAY_BAR_SETTLED_MINUTE = 15 * 60 + 30;

export interface ReplayConfig {
  /** Inclusive Beijing calendar date range, YYYY-MM-DD. */
  startDate: string;
  endDate: string;
  account: Account;
  positions: Position[];
  historyProvider: HistoryProvider;
  memoryDir: string;
  /** Defaults to the full fixed cerebellum matrix; pass a subset to narrow a replay. */
  alarms?: readonly CerebellumAlarmRule[];
  reason?: "replay" | "daily_close" | "manual";
  historyCount?: number;
  /** Deterministic id source for audit events (tests inject a counter). */
  idGenerator?: () => string;
}

export interface ReplaySnapshotRecord {
  asOfDate: string;
  asOfTime: string;
  alarmId: string;
  alarmType: string;
  snapshotId: string;
  filePath: string;
  degraded: boolean;
  sameDayBarIncluded: boolean;
}

export interface ReplaySkipRecord {
  asOfDate: string;
  alarmId: string;
  reason: "not_due";
}

export interface ReplayReport {
  startDate: string;
  endDate: string;
  snapshots: ReplaySnapshotRecord[];
  skipped: ReplaySkipRecord[];
  totalWritten: number;
}

/**
 * Replays a historical Beijing date range day-by-day. For each fixed alarm node it
 * positions a {@link SimulatedClock} at the node's Beijing instant, gates on the
 * EXACT production due-predicate (`isCerebellumAlarmDueAtBeijingTime` — not the
 * side-effecting scheduler), and on a due node builds + persists a point-in-time
 * snapshot bounded to that instant. Zero model/broker/network calls (with a fixture
 * provider). Read-only throughout.
 */
export async function runReplay(config: ReplayConfig): Promise<ReplayReport> {
  const days = enumerateBeijingDays(config.startDate, config.endDate);
  const alarms = [...(config.alarms ?? FIXED_CEREBELLUM_ALARM_RULES)].sort(
    (left, right) => left.priority - right.priority,
  );

  const clock = new SimulatedClock();
  const reader = new AsOfMarketReader({ historyProvider: config.historyProvider });
  const store = new PortfolioSnapshotMemoryStore({
    memoryDir: config.memoryDir,
    now: () => clock.now(),
    idGenerator: config.idGenerator,
  });

  const snapshots: ReplaySnapshotRecord[] = [];
  const skipped: ReplaySkipRecord[] = [];

  for (const day of days) {
    for (const alarm of alarms) {
      clock.setToBeijingInstant(day, alarm.beijingTime);
      const beijingTime = toCerebellumBeijingTime(clock.now());

      if (!isCerebellumAlarmDueAtBeijingTime(alarm, beijingTime)) {
        skipped.push({ asOfDate: day, alarmId: alarm.alarmId, reason: "not_due" });
        continue;
      }

      const asOfTime = clock.now().toISOString();
      const sameDayBarIncluded = beijingTime.minuteOfDay >= SAME_DAY_BAR_SETTLED_MINUTE;

      const snapshot = await buildReplaySnapshot({
        alarmId: alarm.alarmId,
        alarmType: alarm.alarmType,
        jobId: alarm.jobId,
        beijingTime: alarm.beijingTime,
        asOfDate: beijingTime.date,
        asOfTime,
        sameDayBarIncluded,
        account: config.account,
        positions: config.positions,
        reader,
        historyCount: config.historyCount,
        reason: config.reason,
      });
      const write = store.writeSnapshot(snapshot);

      snapshots.push({
        asOfDate: snapshot.asOfDate,
        asOfTime: snapshot.asOfTime,
        alarmId: snapshot.alarmId,
        alarmType: snapshot.alarmType,
        snapshotId: snapshot.snapshotId,
        filePath: write.filePath,
        degraded: snapshot.metadata.degraded,
        sameDayBarIncluded,
      });
    }
  }

  return {
    startDate: config.startDate,
    endDate: config.endDate,
    snapshots,
    skipped,
    totalWritten: snapshots.length,
  };
}

function enumerateBeijingDays(startDate: string, endDate: string): string[] {
  const start = parseUtcMidnight(startDate, "startDate");
  const end = parseUtcMidnight(endDate, "endDate");

  if (start > end) {
    throw new ReplayRunnerError(`startDate ${startDate} must not be after endDate ${endDate}`);
  }

  const days: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const date = new Date(ms);
    days.push(
      `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    );
  }
  return days;
}

function parseUtcMidnight(date: string, label: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ReplayRunnerError(`${label} must be YYYY-MM-DD, got ${date}`);
  }
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    throw new ReplayRunnerError(`${label} is not a valid date: ${date}`);
  }
  return ms;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export class ReplayRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRunnerError";
  }
}
