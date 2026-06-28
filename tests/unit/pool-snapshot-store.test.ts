import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendPoolSnapshot,
  listPoolSnapshots,
  readPoolSnapshotAsOf,
  type PoolSnapshotRecord,
} from "../../src/app/index.js";

function record(asOf: string, date: string, size: number, alarmType?: string): PoolSnapshotRecord {
  return {
    asOf,
    date,
    alarmType,
    size,
    overview: `观察池 ${size} 只`,
    entries: Array.from({ length: size }, (_, index) => ({
      symbol: `60${String(index).padStart(4, "0")}`,
      market: "SSE" as const,
      name: `股${index}`,
      rank: index + 1,
    })),
  };
}

describe("pool-snapshot-store (timestamped 选股历史)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secretary-pool-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("as-of returns the latest snapshot at/just-before the time, never a future one", () => {
    // 2026-06-26 Beijing 09:15 / 10:00 (UTC = -8h: 01:15 / 02:00).
    appendPoolSnapshot(dir, record("2026-06-26T01:15:00.000Z", "2026-06-26", 100, "call_auction_watch"));
    appendPoolSnapshot(dir, record("2026-06-26T02:00:00.000Z", "2026-06-26", 98, "morning_review"));

    // At 09:30 Beijing → the 09:15 snapshot (10:00 hasn't happened yet).
    const at0930 = readPoolSnapshotAsOf(dir, "2026-06-26T01:30:00.000Z");
    expect(at0930?.asOf).toBe("2026-06-26T01:15:00.000Z");
    expect(at0930?.alarmType).toBe("call_auction_watch");

    // At 10:30 Beijing → the 10:00 snapshot.
    const at1030 = readPoolSnapshotAsOf(dir, "2026-06-26T02:30:00.000Z");
    expect(at1030?.alarmType).toBe("morning_review");
    expect(at1030?.size).toBe(98);
  });

  it("falls back to the most recent prior day when the target day has no earlier snapshot", () => {
    appendPoolSnapshot(dir, record("2026-06-25T07:00:00.000Z", "2026-06-25", 90, "post_close_review"));
    // 2026-06-26 08:00 Beijing (00:00 UTC) — no 06-26 snapshot yet → prior day's close pool.
    const preMarket = readPoolSnapshotAsOf(dir, "2026-06-26T00:00:00.000Z");
    expect(preMarket?.date).toBe("2026-06-25");
    expect(preMarket?.size).toBe(90);
  });

  it("returns undefined when nothing was recorded before the time", () => {
    appendPoolSnapshot(dir, record("2026-06-26T02:00:00.000Z", "2026-06-26", 100));
    expect(readPoolSnapshotAsOf(dir, "2026-06-26T00:00:00.000Z")).toBeUndefined();
  });

  it("never records an empty selection; lists a day's snapshots oldest-first", () => {
    appendPoolSnapshot(dir, record("2026-06-26T02:00:00.000Z", "2026-06-26", 0)); // empty → skipped
    appendPoolSnapshot(dir, record("2026-06-26T01:15:00.000Z", "2026-06-26", 100));
    appendPoolSnapshot(dir, record("2026-06-26T02:00:00.000Z", "2026-06-26", 98));
    const day = listPoolSnapshots(dir, "2026-06-26");
    expect(day.map((r) => r.size)).toEqual([100, 98]); // oldest-first, empty skipped
  });
});
