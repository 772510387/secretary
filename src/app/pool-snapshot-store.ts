import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { toBeijingDate } from "../domain/shared/index.js";

/**
 * Timestamped 观察池 (stock-pool) history.
 *
 * The live pool lives in a single overwritten `watchlist_today.json`, so there is no
 * record of WHAT the pool was at 9:15 vs 10:00, and a replay of a past time-point can't
 * reconstruct the pool the model actually saw. This store appends an immutable, timestamped
 * snapshot every time the pool is (re-)selected, and supports an AS-OF read: "the pool as it
 * stood at/just-before time T". That makes selection auditable, replayable, and correctable.
 *
 * One JSONL file per Beijing trading day: `memory/market/pool-snapshots/<date>.jsonl`.
 */
export interface PoolSnapshotEntry {
  symbol: string;
  market: "SSE" | "SZSE";
  name: string;
  rank: number | null;
  bucket?: string;
  changePct?: number | null;
  mainNetInflow?: number | null;
  sealAmount?: number | null;
  consecutiveLimitUpDays?: number | null;
}

export interface PoolSnapshotRecord {
  /** ISO timestamp this selection was produced (the as-of key). */
  asOf: string;
  /** Beijing trading date (YYYY-MM-DD). */
  date: string;
  /** The alarm node that produced it (e.g. call_auction_watch), if any. */
  alarmType?: string;
  size: number;
  /** Rendered 层级1+层级2 overview at selection time. */
  overview: string;
  entries: PoolSnapshotEntry[];
}

const POOL_SNAPSHOT_DIR = ["market", "pool-snapshots"] as const;
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** Appends one immutable pool snapshot to its day's JSONL. Best-effort (never throws to caller). */
export function appendPoolSnapshot(memoryDir: string, record: PoolSnapshotRecord): void {
  try {
    if (record.size === 0) {
      return; // never record an empty selection
    }
    const dir = path.join(memoryDir, ...POOL_SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `${record.date}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // history is best-effort; a write failure must not break 换血
  }
}

/**
 * Returns the latest pool snapshot whose `asOf` is ≤ the given time (same day first, then the
 * most recent prior day) — "the pool as it was before T". Undefined when nothing was recorded
 * before T (the caller then runs a fresh selection and records it).
 */
export function readPoolSnapshotAsOf(memoryDir: string, asOf: string): PoolSnapshotRecord | undefined {
  try {
    const dir = path.join(memoryDir, ...POOL_SNAPSHOT_DIR);
    if (!existsSync(dir)) {
      return undefined;
    }
    const targetDate = toBeijingDate(asOf).date;
    // Days at or before the target date, newest first — stop at the first day that yields a hit.
    const days = readdirSync(dir)
      .filter((file) => DATE_FILE.test(file))
      .map((file) => file.slice(0, 10))
      .filter((date) => date <= targetDate)
      .sort()
      .reverse();

    for (const day of days) {
      const records = readDay(dir, day);
      const eligible = records
        .filter((record) => record.asOf <= asOf)
        .sort((left, right) => left.asOf.localeCompare(right.asOf));
      const latest = eligible[eligible.length - 1];
      if (latest !== undefined) {
        return latest;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** All snapshots recorded on a Beijing date, oldest first (for inspecting "how it updated"). */
export function listPoolSnapshots(memoryDir: string, date: string): PoolSnapshotRecord[] {
  try {
    const dir = path.join(memoryDir, ...POOL_SNAPSHOT_DIR);
    return readDay(dir, date).sort((left, right) => left.asOf.localeCompare(right.asOf));
  } catch {
    return [];
  }
}

function readDay(dir: string, date: string): PoolSnapshotRecord[] {
  const file = path.join(dir, `${date}.jsonl`);
  if (!existsSync(file)) {
    return [];
  }
  const records: PoolSnapshotRecord[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as PoolSnapshotRecord;
      if (typeof parsed.asOf === "string" && Array.isArray(parsed.entries)) {
        records.push(parsed);
      }
    } catch {
      // skip a corrupt line, keep the rest
    }
  }
  return records;
}
