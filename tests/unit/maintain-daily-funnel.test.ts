import { describe, expect, it } from "vitest";
import { maintainDailyFunnel } from "../../src/app/index.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import type { DailyTradingPlan, PlanWatchlistEntry } from "../../src/domain/plan/index.js";
import type { NotificationEvent } from "../../src/domain/notification/index.js";
import type { TradeIntentReviewProposal } from "../../src/domain/memory/index.js";

const ASOF = "2026-06-22T01:00:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  constructor(private readonly structured: JsonValue) {}
  async generate(input: BrainInput): Promise<BrainOutput> {
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock",
      taskType: input.taskType,
      generatedAt: ASOF,
      summary: "",
      structured: this.structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

const POOL: PlanWatchlistEntry[] = [
  { symbol: "000001", market: "SZSE", name: "平安银行", rank: 1 },
  { symbol: "600519", market: "SSE", name: "贵州茅台", rank: 2 },
];

describe("maintainDailyFunnel", () => {
  it("on an EMPTY account still emits BUY proposals + persists plan/proposals + pushes", async () => {
    const plans: DailyTradingPlan[] = [];
    const proposals: TradeIntentReviewProposal[] = [];
    const events: NotificationEvent[] = [];

    const result = await maintainDailyFunnel(
      {
        alarmType: "pre_market_plan",
        tradingDate: "2026-06-22",
        asOf: ASOF,
        accountId: "paper-main",
        watchlist100: POOL,
        holdings: [],
        autoPaper: true, // execute path: wording should say 执行 / paper-only 路径
      },
      {
        brainProvider: new StubBrain({
          shortlist: [{ symbol: "000001", rationale: "好" }],
          orders: [{ symbol: "000001", side: "BUY", rationale: "空仓建仓" }],
        }),
        planStore: { writePlan: (plan) => plans.push(plan) },
        proposalStore: { writeProposal: (proposal) => proposals.push(proposal) },
        notifiers: [{ notify: (event) => events.push(event) }],
      },
    );

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.side).toBe("BUY");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.pendingOrders).toHaveLength(1);
    expect(plans[0]!.safety.liveTrading).toBe(false);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.executionGuard.executable).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]!.severity).toBe("info");
    expect(events[0]!.summary).toContain("选股漏斗");
    expect(events[0]!.summary).toContain("模型选择执行");
    expect(events[0]!.summary).toContain("BUY 000001");
    expect(events[0]!.summary).toContain("空仓建仓");
    expect(events[0]!.recommendedAction).toContain("成交并写入账本");
  });

  it("words a non-trading-hours node as 待买卖 (not 执行) when autoPaper is off", async () => {
    const events: NotificationEvent[] = [];
    await maintainDailyFunnel(
      {
        alarmType: "pre_market_plan",
        tradingDate: "2026-06-22",
        asOf: ASOF,
        accountId: "paper-main",
        watchlist100: POOL,
        holdings: [],
        autoPaper: false, // pre-open / lunch / post-close: plan only, no fill
      },
      {
        brainProvider: new StubBrain({
          shortlist: [{ symbol: "000001", rationale: "好" }],
          orders: [{ symbol: "000001", side: "BUY", rationale: "空仓建仓" }],
        }),
        planStore: { writePlan: () => undefined },
        proposalStore: { writeProposal: () => undefined },
        notifiers: [{ notify: (event) => events.push(event) }],
      },
    );
    expect(events[0]!.summary).toContain("待买/待卖");
    expect(events[0]!.summary).not.toContain("选择执行");
    expect(events[0]!.recommendedAction).toContain("非 A 股连续交易时段");
  });

  it("surfaces 潜力股名单+逐只理由 in the push (not just a count) + full list in metadata", async () => {
    const events: NotificationEvent[] = [];
    await maintainDailyFunnel(
      {
        alarmType: "pre_market_plan",
        tradingDate: "2026-06-22",
        asOf: ASOF,
        accountId: "paper-main",
        watchlist100: POOL,
        holdings: [],
      },
      {
        brainProvider: new StubBrain({
          shortlist: [
            { symbol: "000001", rationale: "主力净流入3.2亿，日线多头" },
            { symbol: "600519", rationale: "白酒题材龙头，封单0.8亿" },
          ],
          orders: [],
        }),
        planStore: { writePlan: () => undefined },
        proposalStore: { writeProposal: () => undefined },
        notifiers: [{ notify: (event) => events.push(event) }],
      },
    );
    // The boss asked "为何选这些股" — the push must name them WITH reasons, not hide behind "候选 N 支".
    expect(events[0]!.summary).toContain("潜力股(为何入选)");
    expect(events[0]!.summary).toContain("平安银行(000001)｜主力净流入3.2亿");
    const shortlistMeta = events[0]!.metadata.shortlist as Array<{ symbol: string; rationale: string }>;
    expect(shortlistMeta).toHaveLength(2);
    expect(shortlistMeta[1]).toMatchObject({ symbol: "600519", rationale: "白酒题材龙头，封单0.8亿" });
  });

  it("forwards poolOverview + 防幻觉约束 into the selection prompt (so rationale cites real signals)", async () => {
    let capturedPrompt = "";
    const capture: BrainProvider = {
      providerName: "mock",
      async generate(input: BrainInput): Promise<BrainOutput> {
        capturedPrompt = input.prompt;
        return {
          requestId: input.requestId,
          provider: "mock",
          model: "mock",
          taskType: input.taskType,
          generatedAt: ASOF,
          summary: "",
          structured: { shortlist: [{ symbol: "000001", rationale: "主力净流入3.2亿" }], orders: [] },
          citations: [],
          confidence: 0.5,
          proposals: [],
        };
      },
    };
    await maintainDailyFunnel(
      {
        alarmType: "pre_market_plan",
        tradingDate: "2026-06-22",
        asOf: ASOF,
        accountId: "paper-main",
        watchlist100: POOL,
        holdings: [],
        poolOverview: "涨停30只(平安银行000001 主力净流入+3.2亿)、热门题材成分15(贵州茅台600519 【白酒】)",
      },
      {
        brainProvider: capture,
        planStore: { writePlan: () => undefined },
        proposalStore: { writeProposal: () => undefined },
      },
    );
    expect(capturedPrompt).toContain("观察池分类概览");
    expect(capturedPrompt).toContain("主力净流入+3.2亿");
    expect(capturedPrompt).toContain("理由硬约束");
    expect(capturedPrompt).toContain("严禁臆造池外代码");
  });

  it("a push failure never breaks the funnel", async () => {
    const result = await maintainDailyFunnel(
      {
        alarmType: "pre_market_plan",
        tradingDate: "2026-06-22",
        asOf: ASOF,
        accountId: "paper-main",
        watchlist100: POOL,
        holdings: [],
      },
      {
        brainProvider: new StubBrain({ shortlist: [{ symbol: "000001", rationale: "好" }], orders: [] }),
        planStore: { writePlan: () => undefined },
        proposalStore: { writeProposal: () => undefined },
        notifiers: [
          {
            notify: () => {
              throw new Error("push down");
            },
          },
        ],
      },
    );
    expect(result.plan.shortlist10).toHaveLength(1);
  });
});
