import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  archiveDailySnapshot,
  ArchiveDailySnapshotError,
  type DailySnapshotSummary,
} from "../../src/app/archive-daily-snapshot.js";
import type { Account, Position } from "../../src/domain/portfolio/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "archive-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

function account(): Account {
  return {
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 100_000,
    cash: { available: 40_000, frozen: 0 },
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

function positions(): Position[] {
  return [
    {
      accountId: "paper-main",
      symbol: "600519",
      market: "SSE",
      name: "贵州茅台",
      quantity: 100,
      availableQuantity: 100,
      todayBuyQuantity: 0,
      frozenQuantity: 0,
      costPrice: 500,
      latestPrice: 600,
      currency: "CNY",
      openedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
    },
  ];
}

function readSummaryLines(summaryPath: string): DailySnapshotSummary[] {
  return readFileSync(summaryPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DailySnapshotSummary);
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("archiveDailySnapshot", () => {
  it("writes the full snapshot and a summary line keyed by tradingDate", () => {
    const memoryDir = makeTempDir();
    const result = archiveDailySnapshot({
      memoryDir,
      account: account(),
      positions: positions(),
      prices: { "600519": 600 },
      tradingDate: "2026-06-22",
      now: "2026-06-22T07:30:00.000Z",
    });

    // Snapshot path is keyed by trading date and contains the priced valuation.
    expect(result.snapshotPath).toBe(
      path.join(memoryDir, "portfolio", "snapshots", "2026-06-22.json"),
    );
    expect(existsSync(result.snapshotPath)).toBe(true);

    const snapshot = JSON.parse(readFileSync(result.snapshotPath, "utf8")) as {
      tradingDate: string;
      account: { accountId: string };
      valuation: { totalAssets: number };
      summary: DailySnapshotSummary;
    };
    expect(snapshot.tradingDate).toBe("2026-06-22");
    expect(snapshot.account.accountId).toBe("paper-main");
    // cash 40,000 + 100 * 600 = 100,000
    expect(snapshot.valuation.totalAssets).toBe(100_000);

    // Summary digest values.
    expect(result.summary).toEqual<DailySnapshotSummary>({
      tradingDate: "2026-06-22",
      totalAssets: 100_000,
      availableCash: 40_000,
      investedRatio: snapshot.summary.investedRatio,
      positionCount: 1,
      totalUnrealizedPnl: 10_000, // (600-500)*100
      generatedAt: "2026-06-22T07:30:00.000Z",
    });

    const lines = readSummaryLines(result.summaryPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tradingDate).toBe("2026-06-22");
  });

  it("replaces (does not duplicate) the summary line on a re-run for the same date", () => {
    const memoryDir = makeTempDir();
    archiveDailySnapshot({
      memoryDir,
      account: account(),
      positions: positions(),
      prices: { "600519": 600 },
      tradingDate: "2026-06-22",
      now: "2026-06-22T07:30:00.000Z",
    });

    // Re-run same date with a different price -> the single line must be replaced.
    const second = archiveDailySnapshot({
      memoryDir,
      account: account(),
      positions: positions(),
      prices: { "600519": 700 },
      tradingDate: "2026-06-22",
      now: "2026-06-22T08:00:00.000Z",
    });

    const lines = readSummaryLines(second.summaryPath);
    expect(lines).toHaveLength(1); // not duplicated
    expect(lines[0]?.totalAssets).toBe(110_000); // 40,000 + 100*700
    expect(lines[0]?.generatedAt).toBe("2026-06-22T08:00:00.000Z");
  });

  it("appends additional dates as new lines without dropping prior ones", () => {
    const memoryDir = makeTempDir();
    archiveDailySnapshot({
      memoryDir,
      account: account(),
      positions: positions(),
      tradingDate: "2026-06-22",
      now: "2026-06-22T07:30:00.000Z",
    });
    const second = archiveDailySnapshot({
      memoryDir,
      account: account(),
      positions: positions(),
      tradingDate: "2026-06-23",
      now: "2026-06-23T07:30:00.000Z",
    });

    const lines = readSummaryLines(second.summaryPath);
    expect(lines.map((line) => line.tradingDate)).toEqual(["2026-06-22", "2026-06-23"]);
  });

  it("rejects a tradingDate that is not YYYY-MM-DD", () => {
    const memoryDir = makeTempDir();
    expect(() =>
      archiveDailySnapshot({
        memoryDir,
        account: account(),
        positions: positions(),
        tradingDate: "2026/06/22",
        now: "2026-06-22T07:30:00.000Z",
      }),
    ).toThrow(ArchiveDailySnapshotError);
  });
});
