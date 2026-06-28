import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildOperationReviewContext } from "../../src/app/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildOperationReviewContext", () => {
  it("joins trades, orders, proposals, plans, reports, audit, and daily performance", () => {
    const memoryDir = createTempMemoryDir();
    const tradingDate = "2026-06-24";

    writeJsonl(path.join(memoryDir, "portfolio", "trades.jsonl"), [
      {
        tradeId: "trade-sell-1",
        accountId: "paper-main",
        intentId: "intent-prop-sell-000636",
        orderId: "order-sell-1",
        symbol: "000636",
        market: "SZSE",
        side: "SELL",
        quantity: 200,
        price: 58.5,
        grossAmount: 11700,
        fees: 5,
        tax: 5.85,
        netAmount: 11689.15,
        currency: "CNY",
        tradeDate: tradingDate,
        tradedAt: "2026-06-24T01:45:00.000Z",
        source: "paper",
      },
    ]);
    writeJsonl(path.join(memoryDir, "portfolio", "orders.jsonl"), [
      {
        orderId: "order-sell-1",
        intentId: "intent-prop-sell-000636",
        accountId: "paper-main",
        symbol: "000636",
        market: "SZSE",
        side: "SELL",
        type: "LIMIT",
        quantity: 200,
        limitPrice: 58.5,
        currency: "CNY",
        status: "filled",
        source: "brain",
        createdAt: "2026-06-24T01:44:30.000Z",
        updatedAt: "2026-06-24T01:45:00.000Z",
      },
    ]);
    writeJson(path.join(memoryDir, "proposals", tradingDate, "prop-sell-000636.json"), {
      proposalId: "prop-sell-000636",
      proposalType: "trade_intent_review",
      status: "approved",
      source: { sourceType: "brain_tool_request", requestId: "req-sell-000636", toolType: "propose_trade_intent" },
      symbol: "000636",
      market: "SZSE",
      name: "风华高科",
      side: "SELL",
      quantity: 200,
      limitPrice: 58.5,
      currency: "CNY",
      rationale: "早盘冲高接近前高，按仓位纪律先卖出 200 股，58.50 作为分批止盈线。",
      reviewReason: "000636 早盘分批止盈",
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      createdAt: "2026-06-24T01:43:00.000Z",
      updatedAt: "2026-06-24T01:43:00.000Z",
      createdBy: { type: "system", id: "brain-agent" },
      metadata: { liveTrading: false },
    });
    writeJson(path.join(memoryDir, "plans", tradingDate, "morning.json"), {
      schemaVersion: 1,
      planId: "plan-20260624",
      tradingDate,
      accountId: "paper-main",
      nodeSequence: 3,
      alarmType: "morning_review",
      generatedAt: "2026-06-24T01:30:00.000Z",
      watchlist100: [{ symbol: "000636", market: "SZSE", name: "风华高科", rank: 1 }],
      shortlist10: [{ symbol: "000636", market: "SZSE", name: "风华高科", rank: 1, rationale: "持仓股冲高，盯 58.50 压力线。" }],
      pendingOrders: [{ proposalId: "prop-sell-000636", symbol: "000636", market: "SZSE", side: "SELL", status: "pending_review", rationale: "58.50 上方分批止盈。" }],
      safety: { liveTrading: false, autoPaper: true },
      metadata: {},
    });
    writeJson(path.join(memoryDir, "reports", tradingDate, "closing.json"), {
      reportType: "closing_review",
      title: "盘后复盘",
      generatedAt: "2026-06-24T07:40:00.000Z",
      contentMarkdown: "000636 早盘按 58.50 分批止盈，尾盘继续观察承接。",
    });
    writeJsonl(path.join(memoryDir, "logs", `audit-${tradingDate}.jsonl`), [
      {
        eventId: "audit-order-1",
        occurredAt: "2026-06-24T01:45:00.000Z",
        actor: { type: "system", id: "paper-broker" },
        action: "order",
        subject: { type: "order", id: "order-sell-1" },
        severity: "info",
        result: "success",
        message: "paper sell filled",
        correlationId: "intent-prop-sell-000636",
        metadata: { symbol: "000636" },
      },
    ]);
    writeJsonl(path.join(memoryDir, "portfolio", "daily-summary.jsonl"), [
      { date: "2026-06-23", totalAssets: 100000, cash: 20000, marketValue: 80000, generatedAt: "2026-06-23T07:30:00.000Z" },
      { date: tradingDate, totalAssets: 101200, cash: 31689.15, marketValue: 69510.85, generatedAt: "2026-06-24T07:30:00.000Z" },
    ]);

    const review = buildOperationReviewContext({
      memoryDir,
      tradingDate,
      symbol: "000636",
      now: "2026-06-24T08:00:00.000Z",
    });

    expect(review.facts.sellCount).toBe(1);
    expect(review.facts.sellAmount).toBe(11689.15);
    expect(review.trades[0]?.beijingTime).toBe("2026-06-24 09:45:00");
    expect(review.trades[0]?.proposalRationale).toContain("58.50");
    expect(review.orders[0]?.limitPrice).toBe(58.5);
    expect(review.proposals[0]?.title).toBe("000636 早盘分批止盈");
    expect(review.plans[0]?.summary).toContain("58.50");
    expect(review.reports[0]?.summary).toContain("分批止盈");
    expect(review.auditEvents[0]?.eventType).toBe("order");
    expect(review.performance?.assetDelta).toBe(1200);
    expect(review.performance?.dailyReturn).toBe(0.012);
    expect(review.dataGaps.some((gap) => gap.includes("成本批次"))).toBe(true);
    expect(review.rendered).toContain("卖出 000636 200股");
    expect(review.rendered).toContain("早盘冲高接近前高");
  });

  it("reports explicit data gaps instead of inventing missing operation facts", () => {
    const memoryDir = createTempMemoryDir();
    const review = buildOperationReviewContext({
      memoryDir,
      tradingDate: "2026-06-24",
      symbol: "000636",
      now: "2026-06-24T08:00:00.000Z",
    });

    expect(review.trades).toHaveLength(0);
    expect(review.dataGaps).toEqual(
      expect.arrayContaining([
        expect.stringContaining("未找到 2026-06-24 000636 的成交流水"),
        expect.stringContaining("无法给出账户级当日盈亏"),
      ]),
    );
  });
});

function createTempMemoryDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "secretary-operation-review-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(file: string, values: unknown[]): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}
