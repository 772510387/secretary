import { beforeAll, describe, expect, it } from "vitest";
import {
  pointInTimeSnapshotSchema,
  type PointInTimeSnapshot,
} from "../../src/domain/portfolio/index.js";
import { AsOfMarketReader, buildReplaySnapshot } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

/**
 * The schema superRefine is the final hard backstop against look-ahead: even if the
 * reader/assembler had a bug, a future-dated snapshot must fail to parse (and thus
 * never persist). These tests craft each leak directly.
 */
let base: PointInTimeSnapshot;

beforeAll(async () => {
  const reader = new AsOfMarketReader({
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
  });
  base = await buildReplaySnapshot({
    alarmId: "post-close-review",
    alarmType: "post_close_review",
    jobId: "cerebellum-post-close-review",
    beijingTime: "15:30",
    asOfDate: "2026-06-19",
    asOfTime: "2026-06-19T07:30:00.000Z", // 15:30 Beijing on 2026-06-19
    sameDayBarIncluded: true,
    account: replayAccount(),
    positions: replayPositions(),
    reader,
    reason: "replay",
  });
});

function clone(): PointInTimeSnapshot {
  return JSON.parse(JSON.stringify(base)) as PointInTimeSnapshot;
}

describe("pointInTimeSnapshotSchema look-ahead backstop", () => {
  it("accepts a well-formed as-of snapshot", () => {
    expect(() => pointInTimeSnapshotSchema.parse(clone())).not.toThrow();
  });

  it("rejects a technical dated after asOfDate", () => {
    const bad = clone();
    bad.market.technicals[0]!.asOfDate = "2026-06-22";
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow(/look-ahead/);
  });

  it("rejects an as_of_close price bar dated after asOfDate", () => {
    const bad = clone();
    const symbol = Object.keys(bad.market.priceSources)[0]!;
    bad.market.priceSources[symbol] = { source: "as_of_close", tradeDate: "2026-06-22" };
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow(/look-ahead/);
  });

  it("rejects account state from after asOfTime", () => {
    const bad = clone();
    bad.account.updatedAt = "2026-06-20T00:00:00.000Z";
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow(/look-ahead/);
  });

  it("rejects position state from after asOfTime", () => {
    const bad = clone();
    bad.positions[0]!.updatedAt = "2026-06-20T00:00:00.000Z";
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow(/look-ahead/);
  });

  it("rejects asOfDate inconsistent with the Beijing date of asOfTime", () => {
    const bad = clone();
    bad.asOfDate = "2026-06-18"; // asOfTime's Beijing date is 2026-06-19
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow();
  });

  it("rejects a recorded history bar after asOfDate", () => {
    const bad = clone();
    const symbol = Object.keys(bad.metadata.historyAsOfDates)[0]!;
    bad.metadata.historyAsOfDates[symbol] = "2026-06-22";
    expect(() => pointInTimeSnapshotSchema.parse(bad)).toThrow(/look-ahead/);
  });
});
