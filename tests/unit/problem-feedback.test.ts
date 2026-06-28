import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProblemFeedbackFactPack } from "../../src/app/index.js";

let root: string;
let memoryDir: string;

beforeEach(() => {
  root = path.join(tmpdir(), `secretary-feedback-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  memoryDir = path.join(root, "memory");
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildProblemFeedbackFactPack", () => {
  it("flags days with plans/proposals but no full 100-pool evidence", () => {
    seedPoolSnapshot("2026-06-22", 100);
    seedPlan("2026-06-23");
    seedProposal("2026-06-23", { symbol: "600519", name: "贵州茅台", side: "BUY" });

    const factPack = buildProblemFeedbackFactPack({
      memoryDir,
      query: "上周为什么只操作了两支线，其他股你确定你有看吗",
      from: "2026-06-22",
      to: "2026-06-23",
      now: "2026-06-24T02:00:00.000Z",
    });

    expect(factPack.ok).toBe(true);
    expect(factPack.summary.expectedTradingDays).toBe(2);
    expect(factPack.summary.daysWithFullPool).toBe(1);
    expect(factPack.summary.daysMissingFullPool).toEqual(["2026-06-23"]);
    expect(factPack.summary.totalProposals).toBe(1);
    expect(factPack.summary.proposedSymbols).toEqual(["贵州茅台(600519)"]);
    expect(factPack.findings.join("\n")).toContain("存在计划/提案/成交但无完整 100 池证据");

    const day = factPack.days.find((item) => item.date === "2026-06-23");
    expect(day?.poolCoverage).toBe("missing");
    expect(day?.notes.join("\n")).toContain("缺少完整观察池覆盖证据");
    expect(day?.evidenceRefs).toContain("plans/2026-06-23/plan.json");
    expect(day?.evidenceRefs).toContain("proposals/2026-06-23/proposal.json");
  });

  it("distinguishes proposals from actual trades", () => {
    seedPoolSnapshot("2026-06-22", 100);
    seedProposal("2026-06-22", { symbol: "000001", name: "平安银行", side: "BUY" });
    seedTrade("2026-06-22", "000001");

    const factPack = buildProblemFeedbackFactPack({
      memoryDir,
      from: "2026-06-22",
      to: "2026-06-22",
      now: "2026-06-24T02:00:00.000Z",
    });

    expect(factPack.summary.totalProposals).toBe(1);
    expect(factPack.summary.totalTrades).toBe(1);
    expect(factPack.summary.proposedSymbols).toEqual(["平安银行(000001)"]);
    expect(factPack.summary.tradedSymbols).toEqual(["000001"]);
    expect(factPack.evidenceRefs).toContain("portfolio/trades.jsonl");
  });
});

function seedPoolSnapshot(date: string, size: number): void {
  const dir = path.join(memoryDir, "market", "pool-snapshots");
  mkdirSync(dir, { recursive: true });
  const record = {
    asOf: `${date}T01:15:00.000Z`,
    date,
    alarmType: "call_auction_watch",
    size,
    overview: `观察池 ${size} 只`,
    entries: [
      { symbol: "600519", market: "SSE", name: "贵州茅台", rank: 1, bucket: "amount_top" },
      { symbol: "000001", market: "SZSE", name: "平安银行", rank: 2, bucket: "hot_sector_leader" },
    ],
  };
  writeFileSync(path.join(dir, `${date}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
}

function seedPlan(date: string): void {
  const dir = path.join(memoryDir, "plans", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ date, source: "test" }), "utf8");
}

function seedProposal(date: string, proposal: { symbol: string; name: string; side: string }): void {
  const dir = path.join(memoryDir, "proposals", date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "proposal.json"), JSON.stringify(proposal), "utf8");
}

function seedTrade(date: string, symbol: string): void {
  const dir = path.join(memoryDir, "portfolio");
  mkdirSync(dir, { recursive: true });
  const trade = {
    tradeId: `trade-${date}-${symbol}`,
    accountId: "paper-main",
    symbol,
    market: symbol.startsWith("6") ? "SSE" : "SZSE",
    side: "BUY",
    quantity: 100,
    price: 10,
    grossAmount: 1000,
    fees: 0,
    tax: 0,
    netAmount: 1000,
    currency: "CNY",
    tradeDate: date,
    tradedAt: `${date}T02:00:00.000Z`,
    source: "paper",
  };
  writeFileSync(path.join(dir, "trades.jsonl"), `${JSON.stringify(trade)}\n`, "utf8");
}
