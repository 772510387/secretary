import { describe, expect, it } from "vitest";
import {
  AgentRouterError,
  classifyAgentIntent,
  describeTurnError,
  runAgentTurn,
} from "../../src/app/index.js";
import {
  accountSchema,
  type Account,
} from "../../src/domain/portfolio/index.js";
import type {
  BrainInput,
  BrainOutput,
  BrainProvider,
} from "../../src/domain/brain/index.js";

const now = "2026-06-17T02:00:00.000Z";

class StubBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  calls = 0;

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.calls += 1;
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: "这是模型的回答。",
      structured: {},
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

describe("classifyAgentIntent", () => {
  it("classifies capability questions", () => {
    expect(classifyAgentIntent("项目现在有什么能力和流程？").intent).toBe("capabilities");
  });

  it("classifies reset commands", () => {
    expect(classifyAgentIntent("清除数据库模拟盘数据").intent).toBe("reset_paper");
  });

  it("classifies build/seed commands and extracts cash", () => {
    const result = classifyAgentIntent("帮我构建一个5万的模拟盘账户");
    expect(result.intent).toBe("seed_paper");
    expect(result.initialCash).toBe(50000);
  });

  it("classifies composite paper ops before generic SOP/chat routing", () => {
    const result = classifyAgentIntent(
      "重新模拟实现一下昨天的操作，以及更新数据库信息，在模拟今日的操作",
      "2026-06-23T01:00:00.000Z",
    );
    expect(result.intent).toBe("paper_ops");
    expect(result.paperOps).toMatchObject({
      replayDate: "2026-06-22",
      archiveDate: "2026-06-23",
      simulateDate: "2026-06-23",
    });
  });

  it("classifies standalone replay-yesterday paper ops without adding today's nodes", () => {
    const result = classifyAgentIntent(
      "昨天，模拟昨天的操作",
      "2026-06-23T01:00:00.000Z",
    );

    expect(result.intent).toBe("paper_ops");
    expect(result.paperOps).toEqual({ replayDate: "2026-06-22" });
  });

  it("falls back to ask for general questions", () => {
    expect(classifyAgentIntent("现在盘面怎么样？").intent).toBe("ask");
  });
});

describe("runAgentTurn", () => {
  const deps = { brainProvider: new StubBrain() };

  it("answers capabilities deterministically without the model", async () => {
    const brain = new StubBrain();
    const result = await runAgentTurn({ message: "有哪些功能？" }, { brainProvider: brain });

    expect(result.intent).toBe("capabilities");
    expect(result.reply).toContain("能力");
    expect(brain.calls).toBe(0);
  });

  it("requires confirmation before resetting, then returns an action", async () => {
    const unconfirmed = await runAgentTurn({ message: "清空模拟盘数据" }, deps);
    expect(unconfirmed).toMatchObject({ intent: "reset_paper", requiresConfirmation: true });
    expect(unconfirmed.action).toBeUndefined();

    const confirmed = await runAgentTurn(
      { message: "清空模拟盘数据", confirmed: true },
      deps,
    );
    expect(confirmed).toMatchObject({
      intent: "reset_paper",
      requiresConfirmation: false,
      action: { type: "reset_paper" },
    });
  });

  it("returns a seed action with extracted cash once confirmed", async () => {
    const result = await runAgentTurn(
      { message: "帮我构建一个3万的模拟盘账户", confirmed: true },
      deps,
    );
    expect(result.action).toEqual({ type: "seed_paper", initialCash: 30000 });
  });

  it("gates composite paper ops behind confirmation", async () => {
    const message = "重新模拟实现一下昨天的操作，以及更新数据库信息，在模拟今日的操作";
    const unconfirmed = await runAgentTurn({ message }, deps);
    expect(unconfirmed).toMatchObject({ intent: "paper_ops", requiresConfirmation: true });
    expect(unconfirmed.action).toBeUndefined();

    const confirmed = await runAgentTurn({ message, confirmed: true }, deps);
    expect(confirmed.action).toMatchObject({ type: "paper_ops" });
  });

  it("routes general questions to the model over the DB", async () => {
    const brain = new StubBrain();
    const result = await runAgentTurn(
      { message: "我仓位重不重？", account: makeAccount(), positions: [] },
      { brainProvider: brain },
    );

    expect(result.intent).toBe("ask");
    expect(result.reply).toBe("这是模型的回答。");
    expect(brain.calls).toBe(1);
  });

  it("refuses account questions when no account exists", async () => {
    await expect(
      runAgentTurn({ message: "我现在持仓怎么样？" }, deps),
    ).rejects.toThrow(AgentRouterError);
  });
});

describe("describeTurnError", () => {
  it("surfaces user-actionable AgentRouterError messages verbatim", () => {
    expect(describeTurnError(new AgentRouterError("请先初始化模拟盘账户。"))).toBe(
      "请先初始化模拟盘账户。",
    );
  });

  it("gives a helpful hint for timeouts instead of a generic error", () => {
    expect(describeTurnError(new Error("DashScopeQwenProvider request timed out after 60000ms"))).toContain(
      "超时",
    );
  });

  it("falls back to a generic message for unexpected errors", () => {
    expect(describeTurnError(new Error("ECONNRESET"))).toBe("处理出错了，请稍后再试。");
  });
});

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
