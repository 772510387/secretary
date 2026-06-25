import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDailyTradingPlan,
  dailyTradingPlanSchema,
  reviseWithNode,
  selectTopNByRank,
  snapshotWatchlist,
  type PlanWatchlistEntry,
} from "../../src/domain/plan/index.js";
import { PlanMemoryStore } from "../../src/infrastructure/storage/index.js";
import { watchlistEntrySchema } from "../../src/domain/market/index.js";

const NOW = "2026-06-22T01:00:00.000Z";

function pool(): PlanWatchlistEntry[] {
  return [
    { symbol: "000001", market: "SZSE", name: "平安银行", rank: 1 },
    { symbol: "000002", market: "SZSE", name: "万科A", rank: 2 },
    { symbol: "600519", market: "SSE", name: "贵州茅台", rank: 3 },
  ];
}

function basePlan() {
  return buildDailyTradingPlan({
    tradingDate: "2026-06-22",
    accountId: "paper-main",
    alarmType: "pre_market_plan",
    generatedAt: NOW,
    watchlist100: pool(),
    shortlist10: [
      { symbol: "000001", market: "SZSE", name: "平安银行", rank: 1, rationale: "趋势好" },
    ],
  });
}

describe("DailyTradingPlan domain", () => {
  it("builds a plan that is hard-wired non-live and starts at nodeSequence 0", () => {
    const plan = basePlan();
    expect(plan.schemaVersion).toBe(1);
    expect(plan.nodeSequence).toBe(0);
    expect(plan.safety.liveTrading).toBe(false);
    expect(plan.pendingOrders).toEqual([]);
  });

  it("rejects a shortlist symbol that is not in the 100-pool (no smuggled codes)", () => {
    expect(() =>
      buildDailyTradingPlan({
        tradingDate: "2026-06-22",
        accountId: "paper-main",
        alarmType: "pre_market_plan",
        generatedAt: NOW,
        watchlist100: pool(),
        shortlist10: [
          { symbol: "999999", market: "SZSE", name: "幽灵股", rank: null, rationale: "凭空冒出" },
        ],
      }),
    ).toThrow(/not in the watchlist100 pool/);
  });

  it("rejects more than 10 shortlist entries and a non-1 schemaVersion", () => {
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      symbol: String(i).padStart(6, "0"),
      market: "SZSE" as const,
      name: "x",
      rank: i + 1,
      rationale: "r",
    }));
    expect(() => dailyTradingPlanSchema.parse({ ...basePlan(), shortlist10: tooMany })).toThrow();
    expect(() => dailyTradingPlanSchema.parse({ ...basePlan(), schemaVersion: 2 })).toThrow();
  });

  it("reviseWithNode bumps the sequence and carries unspecified layers forward", () => {
    const plan = basePlan();
    const revised = reviseWithNode(plan, { alarmType: "midday_review", generatedAt: "2026-06-22T03:30:00.000Z" });
    expect(revised.nodeSequence).toBe(1);
    expect(revised.alarmType).toBe("midday_review");
    expect(revised.watchlist100).toEqual(plan.watchlist100); // carried forward
  });

  it("selectTopNByRank is a deterministic fallback ordered by rank", () => {
    const top2 = selectTopNByRank(pool(), 2);
    expect(top2.map((e) => e.symbol)).toEqual(["000001", "000002"]);
    expect(top2[0]!.rationale).toContain("降级");
  });

  it("snapshotWatchlist copies a lean snapshot (rank from metadata)", () => {
    const entry = watchlistEntrySchema.parse({
      symbol: "000001",
      market: "SZSE",
      name: "平安银行",
      priority: "high",
      reason: "成交额居前",
      source: "screener",
      updatedAt: NOW,
      metadata: { rank: 1 },
    });
    expect(snapshotWatchlist([entry])).toEqual([
      { symbol: "000001", market: "SZSE", name: "平安银行", rank: 1 },
    ]);
  });
});

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PlanMemoryStore", () => {
  it("persists one file per node revision + a redacted audit event", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "plan-memory-"));
    tmpDirs.push(dir);
    const store = new PlanMemoryStore({ memoryDir: dir, now: () => new Date(NOW), idGenerator: () => "evt-1" });

    const plan = basePlan();
    const r0 = store.writePlan(plan);
    const r1 = store.writePlan(reviseWithNode(plan, { alarmType: "closing_snapshot", generatedAt: NOW }));

    expect(existsSync(r0.filePath)).toBe(true);
    expect(existsSync(r1.filePath)).toBe(true);
    expect(r0.filePath).not.toBe(r1.filePath); // per-node snapshots, not overwritten
    expect(r0.filePath).toContain("seq0");
    expect(r1.filePath).toContain("seq1");

    const persisted = JSON.parse(readFileSync(r0.filePath, "utf8"));
    expect(persisted.safety.liveTrading).toBe(false);

    const logsDir = path.join(dir, "logs");
    let auditEvents = 0;
    for (const file of readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(path.join(logsDir, file), "utf8").trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.actor.id === "plan-memory-store") {
          auditEvents += 1;
          expect(event.metadata.liveTrading).toBe(false);
          expect(Object.keys(event.metadata)).toContain("watchlistCount");
        }
      }
    }
    expect(auditEvents).toBe(2);
  });
});
