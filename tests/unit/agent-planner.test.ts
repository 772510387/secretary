import { describe, expect, it } from "vitest";
import {
  fulfilTurnPlan,
  planAgentTurn,
  runPlannedAgentTurn,
  type AgentPlannerDependencies,
  type ResearchRunner,
} from "../../src/app/index.js";
import {
  researchReportSchema,
  type ResearchReport,
  type ResearchTask,
} from "../../src/domain/research/index.js";
import { positionSchema, type Position } from "../../src/domain/portfolio/index.js";
import {
  brainOutputSchema,
  turnPlanSchema,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
  type TurnPlan,
} from "../../src/domain/brain/index.js";
import {
  accountSchema,
  type Account,
} from "../../src/domain/portfolio/index.js";

const now = "2026-06-21T01:00:00.000Z";

/**
 * A brain whose router call returns a configured route (in `structured`) and whose
 * answer call returns a fixed summary. The two are told apart by the router marker
 * that `buildTurnPlannerBrainInput` sets on the context.
 */
class PlannerStubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  routeCalls = 0;
  askCalls = 0;

  constructor(
    private readonly route: unknown,
    private readonly answer = "模型回答。",
  ) {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    const isRouter = (input.context as { router?: boolean }).router === true;

    if (isRouter) {
      this.routeCalls += 1;
      return this.output(input, this.route, "路由判断。");
    }

    this.askCalls += 1;
    return this.output(input, { answered: true }, this.answer);
  }

  private output(input: BrainInput, structured: unknown, summary: string): BrainOutput {
    return brainOutputSchema.parse({
      requestId: input.requestId,
      provider: "mock",
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary,
      structured,
      citations: [],
      confidence: 0.5,
      proposals: [],
    });
  }
}

function deps(route: unknown, answer?: string): AgentPlannerDependencies {
  return { brainProvider: new PlannerStubBrain(route, answer) };
}

function makePlan(partial: Partial<TurnPlan> & { intent: TurnPlan["intent"] }): TurnPlan {
  return turnPlanSchema.parse(partial);
}

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
    costPrice: 74,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
  });
}

function makeReport(task: ResearchTask): ResearchReport {
  return researchReportSchema.parse({
    reportId: "research-r1",
    taskId: task.taskId,
    provider: "trading_agents_cn",
    symbol: task.symbol,
    market: task.market,
    name: task.name,
    tradingDate: task.tradingDate,
    generatedAt: now,
    title: "深度研判",
    summary: "多智能体结论：技术超买，建议卖出。",
    conclusion: "bearish",
    confidence: 0.9,
    findings: [{ findingId: "f1", category: "market", statement: "MACD 顶背离，60日高位。", evidence: [], confidence: 0.9 }],
    bullBearViews: [
      { side: "bull", thesis: "趋势仍多头排列。", evidence: [], confidence: 0.6 },
      { side: "bear", thesis: "高位回调压力大。", evidence: [], confidence: 0.8 },
    ],
    riskFactors: [{ riskId: "k1", severity: "warning", description: "短期回调风险。" }],
    sources: [],
    tradeIntentDrafts: [{ draftId: "d1", symbol: task.symbol, market: task.market, side: "SELL", rationale: "超买。", source: "research", requiresReview: true, executable: false }],
    requiresHumanReview: true,
    degraded: false,
    metadata: {},
  });
}

function stubResearchRunner(): ResearchRunner & { calls: number } {
  const runner = {
    calls: 0,
    async runResearch(task: ResearchTask): Promise<ResearchReport> {
      runner.calls += 1;
      return makeReport(task);
    },
  };
  return runner;
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

describe("planAgentTurn (model-driven routing)", () => {
  it("routes a SOP request to run_sop with the model-selected sopName", async () => {
    const { plan, routedBy } = await planAgentTurn(
      { message: "帮我做个盘前计划" },
      deps({ intent: "run_sop", sopName: "pre-market-plan" }),
    );

    expect(routedBy).toBe("model");
    expect(plan.intent).toBe("run_sop");
    expect(plan.sopName).toBe("pre-market-plan");
  });

  it("fast-paths a bare greeting to smalltalk without any model call", async () => {
    const brain = new PlannerStubBrain({ intent: "chat" });
    const { plan, routedBy } = await planAgentTurn({ message: "你好" }, { brainProvider: brain });

    expect(routedBy).toBe("fast_path");
    expect(plan.intent).toBe("smalltalk");
    expect(brain.routeCalls).toBe(0);
  });

  it("still asks the model for a non-trivial greeting", async () => {
    const { plan, routedBy } = await planAgentTurn(
      { message: "跟你聊两句，最近行情怎么看" },
      deps({ intent: "smalltalk" }),
    );

    expect(routedBy).toBe("model");
    expect(plan.intent).toBe("smalltalk");
  });

  it("coerces an unknown SOP name back to chat", async () => {
    const { plan } = await planAgentTurn(
      { message: "随便聊聊" },
      deps({ intent: "run_sop", sopName: "does-not-exist" }),
    );

    expect(plan.intent).toBe("chat");
  });

  it("always forces confirmation for destructive routes even if the model says false", async () => {
    const { plan } = await planAgentTurn(
      { message: "清掉模拟盘重来" },
      deps({ intent: "reset_paper", requiresConfirmation: false }),
    );

    expect(plan.intent).toBe("reset_paper");
    expect(plan.requiresConfirmation).toBe(true);
  });

  it("fast-paths composite paper ops before the model can misroute it to a SOP", async () => {
    const brain = new PlannerStubBrain({ intent: "run_sop", sopName: "post-close-review" });
    const { plan, routedBy } = await planAgentTurn(
      {
        message: "重新模拟实现一下昨天的操作，以及更新数据库信息，在模拟今日的操作",
        now: "2026-06-23T14:00:00.000Z",
      },
      { brainProvider: brain },
    );

    expect(routedBy).toBe("fast_path");
    expect(brain.routeCalls).toBe(0);
    expect(plan).toMatchObject({
      intent: "paper_ops",
      requiresConfirmation: true,
      replayDate: "2026-06-22",
      archiveDate: "2026-06-23",
      simulateDate: "2026-06-23",
    });
  });

  it("fast-paths standalone replay-yesterday paper ops without today's archive/simulate defaults", async () => {
    const brain = new PlannerStubBrain({
      intent: "paper_ops",
      replayDate: "2024-06-18",
      simulateDate: "2026-06-23",
      archiveDate: "2026-06-23",
      requiresConfirmation: true,
    });
    const { plan, routedBy } = await planAgentTurn(
      {
        message: "昨天，模拟昨天的操作",
        now: "2026-06-23T01:00:00.000Z",
      },
      { brainProvider: brain },
    );

    expect(routedBy).toBe("fast_path");
    expect(brain.routeCalls).toBe(0);
    expect(plan).toEqual({
      intent: "paper_ops",
      requiresConfirmation: true,
      replayDate: "2026-06-22",
    });
  });

  it("falls back to the deterministic classifier when the model returns no usable route", async () => {
    const { plan, routedBy } = await planAgentTurn(
      { message: "清空模拟盘数据" },
      deps({}), // empty structured -> not a plan
    );

    expect(routedBy).toBe("fallback");
    expect(plan.intent).toBe("reset_paper");
    expect(plan.requiresConfirmation).toBe(true);
  });

  it("falls back to chat when the brain throws", async () => {
    const brain: BrainProvider = {
      providerName: "mock",
      generate: () => Promise.reject(new Error("boom")),
    };
    const { plan, routedBy } = await planAgentTurn({ message: "我仓位重不重？" }, { brainProvider: brain });

    expect(routedBy).toBe("fallback");
    expect(plan.intent).toBe("chat");
  });
});

describe("fulfilTurnPlan (deterministic gating)", () => {
  it("answers capabilities without calling the model", async () => {
    const brain = new PlannerStubBrain({});
    const result = await fulfilTurnPlan(
      makePlan({ intent: "capabilities" }),
      { message: "有什么能力？" },
      { brainProvider: brain },
    );

    expect(result.reply).toContain("能力");
    expect(brain.askCalls).toBe(0);
  });

  it("answers smalltalk from the plan reply with no extra model call", async () => {
    const brain = new PlannerStubBrain({});
    const result = await fulfilTurnPlan(
      makePlan({ intent: "smalltalk", reply: "你好呀！想看盘还是问持仓？" }),
      { message: "你好" },
      { brainProvider: brain },
    );

    expect(result.intent).toBe("smalltalk");
    expect(result.reply).toBe("你好呀！想看盘还是问持仓？");
    expect(brain.routeCalls).toBe(0);
    expect(brain.askCalls).toBe(0);
  });

  it("uses a friendly default greeting when the plan has no reply", async () => {
    const result = await fulfilTurnPlan(
      makePlan({ intent: "smalltalk" }),
      { message: "你好" },
      deps({}),
    );

    expect(result.intent).toBe("smalltalk");
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("gates reset behind confirmation, then returns an action", async () => {
    const plan = makePlan({ intent: "reset_paper", requiresConfirmation: true });

    const unconfirmed = await fulfilTurnPlan(plan, { message: "清空" }, deps({}));
    expect(unconfirmed.requiresConfirmation).toBe(true);
    expect(unconfirmed.action).toBeUndefined();

    const confirmed = await fulfilTurnPlan(plan, { message: "清空", confirmed: true }, deps({}));
    expect(confirmed.action).toEqual({ type: "reset_paper" });
  });

  it("returns a seed action carrying the model-extracted cash", async () => {
    const result = await fulfilTurnPlan(
      makePlan({ intent: "seed_paper", initialCash: 30000, requiresConfirmation: true }),
      { message: "建个3万的账户", confirmed: true },
      deps({}),
    );

    expect(result.action).toEqual({ type: "seed_paper", initialCash: 30000 });
  });

  it("returns a paper_ops action only after confirmation", async () => {
    const plan = makePlan({
      intent: "paper_ops",
      requiresConfirmation: true,
      replayDate: "2026-06-22",
      archiveDate: "2026-06-23",
      simulateDate: "2026-06-23",
    });

    const unconfirmed = await fulfilTurnPlan(plan, { message: "补跑一下" }, deps({}));
    expect(unconfirmed.requiresConfirmation).toBe(true);
    expect(unconfirmed.action).toBeUndefined();

    const confirmed = await fulfilTurnPlan(plan, { message: "补跑一下", confirmed: true }, deps({}));
    expect(confirmed.action).toEqual({
      type: "paper_ops",
      replayDate: "2026-06-22",
      archiveDate: "2026-06-23",
      simulateDate: "2026-06-23",
    });
  });

  it("uses deterministic paper-op dates over model-provided hallucinated dates", async () => {
    const plan = makePlan({
      intent: "paper_ops",
      requiresConfirmation: true,
      replayDate: "2024-06-18",
      archiveDate: "2026-06-23",
      simulateDate: "2026-06-23",
    });

    const result = await fulfilTurnPlan(
      plan,
      {
        message: "昨天，模拟昨天的操作",
        now: "2026-06-23T01:00:00.000Z",
        confirmed: true,
      },
      deps({}),
    );

    expect(result.action).toEqual({
      type: "paper_ops",
      replayDate: "2026-06-22",
    });
  });

  it("runs a SOP over the account context and labels the reply", async () => {
    const brain = new PlannerStubBrain({}, "盘前计划内容。");
    const result = await fulfilTurnPlan(
      makePlan({ intent: "run_sop", sopName: "pre-market-plan" }),
      { message: "盘前计划", account: makeAccount(), positions: [] },
      { brainProvider: brain },
    );

    expect(result.intent).toBe("run_sop");
    expect(result.sopName).toBe("pre-market-plan");
    expect(result.reply).toContain("盘前计划");
    expect(brain.askCalls).toBe(1);
  });

  it("refuses chat/SOP when no account exists", async () => {
    await expect(
      fulfilTurnPlan(makePlan({ intent: "chat" }), { message: "我持仓如何？" }, deps({})),
    ).rejects.toThrow();
  });

  it("runs deep_research on the held position via the research runner", async () => {
    const runner = stubResearchRunner();
    const result = await fulfilTurnPlan(
      makePlan({ intent: "deep_research" }),
      { message: "帮我深度分析下周怎么操作", account: makeAccount(), positions: [makePosition()], now },
      { brainProvider: new PlannerStubBrain({}), researchRunner: runner },
    );

    expect(runner.calls).toBe(1);
    expect(result.intent).toBe("deep_research");
    expect(result.reply).toContain("深度研判");
    expect(result.reply).toContain("偏空");
    expect(result.reply).toContain("000636");
  });

  it("targets the model-named symbol when one is given", async () => {
    const runner = stubResearchRunner();
    let seenSymbol = "";
    runner.runResearch = async (task) => {
      seenSymbol = task.symbol;
      return makeReport(task);
    };

    await fulfilTurnPlan(
      makePlan({ intent: "deep_research", symbol: "601187" }),
      { message: "深度分析厦门银行", account: makeAccount(), positions: [makePosition()], now },
      { brainProvider: new PlannerStubBrain({}), researchRunner: runner },
    );

    expect(seenSymbol).toBe("601187");
  });

  it("degrades deep_research to a quick chat answer when no research runner is configured", async () => {
    const brain = new PlannerStubBrain({}, "快速点评：仓位偏重。");
    const result = await fulfilTurnPlan(
      makePlan({ intent: "deep_research" }),
      { message: "分析下周操作", account: makeAccount(), positions: [makePosition()] },
      { brainProvider: brain },
    );

    expect(result.reply).toBe("快速点评：仓位偏重。");
    expect(brain.askCalls).toBe(1);
  });
});

describe("runPlannedAgentTurn (end to end)", () => {
  it("model-routes a natural-language SOP request and produces the SOP answer", async () => {
    const result = await runPlannedAgentTurn(
      { message: "帮我做个盘前计划", account: makeAccount(), positions: [] },
      deps({ intent: "run_sop", sopName: "pre-market-plan" }, "今日计划要点。"),
    );

    expect(result.intent).toBe("run_sop");
    expect(result.routedBy).toBe("model");
    expect(result.reply).toContain("盘前计划");
    expect(result.reply).toContain("今日计划要点。");
  });

  it("model-routes a casual question to chat", async () => {
    const result = await runPlannedAgentTurn(
      { message: "我仓位重不重？", account: makeAccount(), positions: [] },
      deps({ intent: "chat" }, "你的仓位不算重。"),
    );

    expect(result.intent).toBe("chat");
    expect(result.reply).toBe("你的仓位不算重。");
  });
});
