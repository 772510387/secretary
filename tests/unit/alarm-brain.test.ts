import { describe, expect, it } from "vitest";
import { runAlarmNodeAnalysis } from "../../src/app/index.js";
import { accountSchema, positionSchema, type Account, type Position } from "../../src/domain/portfolio/index.js";
import type {
  BrainInput,
  BrainOutput,
  BrainProvider,
} from "../../src/domain/brain/index.js";

const now = "2026-06-21T00:30:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  lastPrompt = "";

  constructor(private readonly summary = "今日基调防守，关注风华高科压力位，半仓应对。") {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.lastPrompt = input.prompt;
    return {
      requestId: input.requestId,
      provider: "mock",
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: this.summary,
      structured: {},
      citations: [],
      confidence: 0.6,
      proposals: [],
    };
  }
}

function makeAccount(): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: { available: 20000, frozen: 0 },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

describe("runAlarmNodeAnalysis", () => {
  it("runs the node SOP through the brain and returns a report + pushable notification", async () => {
    const brain = new StubBrain();
    const result = await runAlarmNodeAnalysis(
      { alarmType: "pre_market_plan", account: makeAccount(), positions: [], now },
      { brainProvider: brain },
    );

    expect(result.title).toBe("盘前计划");
    expect(result.report).toBe("今日基调防守，关注风华高科压力位，半仓应对。");
    // The SOP objective/constraints reach the brain, not an empty task object.
    expect(brain.lastPrompt).toContain("盘前计划");
    expect(brain.lastPrompt).toContain("唤醒规则：");
    expect(brain.lastPrompt).toContain("操作指令：");
    expect(brain.lastPrompt).toContain("1. ");
    expect(brain.lastPrompt).toContain("操作汇报格式");
    expect(brain.lastPrompt).toContain("本节点操作判断");
    expect(brain.lastPrompt).toContain("最终是否成交由后端 paper-only 规则");
    expect(brain.lastPrompt).toContain("盘前市场背景呈现");
    expect(brain.lastPrompt).toContain("大盘情况");
    expect(brain.lastPrompt).toContain("热点板块");
    expect(brain.lastPrompt).toContain("连板股");
    expect(brain.lastPrompt).toContain("安全边界：");
    // The result is a real, pushable notification.
    expect(result.notification.summary).toContain("【盘前计划】");
    expect(result.notification.channels).toContain("wechat");
    expect(result.notification.severity).toBe("info");
  });

  it("keeps deep alarm reports beyond the old 1000-char push ceiling", async () => {
    const longSummary = `本节点操作判断：持有观察。\n${"观察：大盘、板块、持仓、100池逐项复核。".repeat(120)}\n尾部结论：等待下一次复查。`;
    const brain = new StubBrain(longSummary);
    const result = await runAlarmNodeAnalysis(
      { alarmType: "morning_review", account: makeAccount(), positions: [makePosition()], now },
      { brainProvider: brain },
    );

    expect(result.notification.summary.length).toBeGreaterThan(1000);
    expect(result.notification.summary).toContain("尾部结论：等待下一次复查。");
    // F1: intraday review nodes carry the 观察→判断→下次复查 display skeleton + persona.
    expect(brain.lastPrompt).toContain("盘中节点呈现");
    expect(brain.lastPrompt).toContain("下次复查");
    expect(brain.lastPrompt).toContain("Boss 摘要");
  });

  it("forces a per-holding overnight-impact assessment on morning news nodes (PRE-03)", async () => {
    const brain = new StubBrain();
    await runAlarmNodeAnalysis(
      {
        alarmType: "overnight_digest",
        account: makeAccount(),
        positions: [makePosition()],
        now,
      },
      { brainProvider: brain },
    );

    expect(brain.lastPrompt).toContain("逐条持仓影响评估");
    expect(brain.lastPrompt).toContain("风华高科(000636)");
    expect(brain.lastPrompt).toContain("利好/利空/中性");
  });
});

function makePosition(): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 200,
    availableQuantity: 200,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 56.68,
    latestPrice: 64.3,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
  });
}
