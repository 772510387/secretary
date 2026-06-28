import { describe, expect, it, vi } from "vitest";
import {
  createWeChatBridgeState,
  runWeChatBridgeTurn,
  type WeChatBridgeDependencies,
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
  async generate(input: BrainInput): Promise<BrainOutput> {
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: "模型回答。",
      structured: {},
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

class CapturingBrain implements BrainProvider {
  readonly providerName = "mock" as const;
  prompts: string[] = [];
  async generate(input: BrainInput): Promise<BrainOutput> {
    this.prompts.push(input.prompt);
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: "这是答复。",
      structured: {},
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

function makeDeps(overrides: Partial<WeChatBridgeDependencies> = {}): WeChatBridgeDependencies {
  return {
    brainProvider: new StubBrain(),
    isAllowed: () => true,
    allowDestructive: () => true,
    loadContext: () => ({ account: makeAccount(), positions: [] }),
    executeAction: () => "已写入。",
    ...overrides,
  };
}

describe("runWeChatBridgeTurn", () => {
  it("refuses non-allowlisted peers", async () => {
    const reply = await runWeChatBridgeTurn(
      { peerId: "stranger", text: "清除模拟盘数据" },
      makeDeps({ isAllowed: () => false }),
      createWeChatBridgeState(),
    );
    expect(reply.reply).toContain("授权名单");
  });

  it("answers general questions via the model", async () => {
    const reply = await runWeChatBridgeTurn(
      { peerId: "owner", text: "我仓位重不重？" },
      makeDeps(),
      createWeChatBridgeState(),
    );
    expect(reply.reply).toBe("模型回答。");
  });

  it("fast-paths complete grounded trading-day reviews without model routing", async () => {
    const brain = new CapturingBrain();
    const buildReview = vi.fn(() => "# 2026-06-09 完整交易日复盘\n\n总盈亏：+¥1,055.00");
    const progress = vi.fn();

    const reply = await runWeChatBridgeTurn(
      { peerId: "owner", text: "来一个2026-06-09完整交易日复盘" },
      makeDeps({
        brainProvider: brain,
        buildTradingDayReview: buildReview,
        onProgress: progress,
      }),
      createWeChatBridgeState(),
    );

    expect(reply.reply).toContain("完整交易日复盘");
    expect(reply.reply).toContain("+¥1,055.00");
    expect(buildReview).toHaveBeenCalledWith({
      message: "来一个2026-06-09完整交易日复盘",
      now: expect.any(String),
    });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("接地交易日复盘"));
    expect(brain.prompts).toHaveLength(0);
  });

  it("runs a two-step confirm flow for destructive ops and only executes on 确认", async () => {
    const execute = vi.fn(() => "已写入 4 个文件。");
    const deps = makeDeps({ executeAction: execute });
    const state = createWeChatBridgeState();

    const prompt = await runWeChatBridgeTurn(
      { peerId: "owner", text: "清除模拟盘数据" },
      deps,
      state,
    );
    expect(prompt.reply).toContain("确认");
    expect(execute).not.toHaveBeenCalled();
    expect(state.pending.get("owner")).toMatchObject({ type: "reset_paper" });

    const done = await runWeChatBridgeTurn({ peerId: "owner", text: "确认" }, deps, state);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(done.reply).toContain("已执行");
    expect(state.pending.has("owner")).toBe(false);
  });

  it("keeps composite paper ops behind the same confirmation flow", async () => {
    const execute = vi.fn((_action: unknown) => "已补跑并落库。");
    const progress = vi.fn();
    const deps = makeDeps({ executeAction: execute, onProgress: progress });
    const state = createWeChatBridgeState();
    const message = "重新模拟实现一下昨天的操作，以及更新数据库信息，在模拟今日的操作";

    const prompt = await runWeChatBridgeTurn({ peerId: "owner", text: message }, deps, state);
    expect(prompt.reply).toContain("模拟运维");
    expect(execute).not.toHaveBeenCalled();
    expect(state.pending.get("owner")).toMatchObject({ type: "paper_ops" });

    const done = await runWeChatBridgeTurn({ peerId: "owner", text: "确认" }, deps, state);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ type: "paper_ops" });
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("模拟运维"));
    expect(done.reply).toContain("已补跑并落库");
  });

  it("can run confirmed paper ops in the background and push the final result", async () => {
    let resolveAction: (value: string) => void = () => undefined;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveAction = resolve;
        }),
    );
    const progress = vi.fn();
    const deps = makeDeps({
      executeAction: execute,
      onProgress: progress,
      runConfirmedPaperOpsInBackground: true,
      now: () => new Date("2026-06-23T01:00:00.000Z"),
    });
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "模拟昨天的操作" }, deps, state);
    const accepted = await runWeChatBridgeTurn({ peerId: "owner", text: "确认" }, deps, state);

    expect(accepted.reply).toContain("已受理");
    expect(accepted.reply).toContain("后台执行");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.pending.has("owner")).toBe(false);

    resolveAction("已忠实重演 2026-06-22。");
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(expect.stringContaining("已忠实重演 2026-06-22")),
    );
  });

  it("keeps standalone replay-yesterday ops as replay-only in pending confirmation", async () => {
    const execute = vi.fn(() => "已重演。");
    const deps = makeDeps({
      executeAction: execute,
      now: () => new Date("2026-06-23T01:00:00.000Z"),
    });
    const state = createWeChatBridgeState();

    const prompt = await runWeChatBridgeTurn(
      { peerId: "owner", text: "昨天，模拟昨天的操作" },
      deps,
      state,
    );

    expect(prompt.reply).toContain("重演 2026-06-22");
    expect(prompt.reply).not.toContain("补跑 2026-06-23");
    expect(prompt.reply).not.toContain("归档 2026-06-23");
    expect(state.pending.get("owner")).toEqual({
      type: "paper_ops",
      replayDate: "2026-06-22",
    });
  });

  it("does not attach an executable action to an unconfirmed seed prompt", async () => {
    const execute = vi.fn(() => "done");
    const deps = makeDeps({ executeAction: execute });
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "帮我构建一个3万的模拟盘账户" }, deps, state);

    expect(execute).not.toHaveBeenCalled();
    expect(state.pending.get("owner")).toMatchObject({ type: "seed_paper", initialCash: 30000 });
  });

  it("cancels a pending op on 取消", async () => {
    const execute = vi.fn(() => "x");
    const deps = makeDeps({ executeAction: execute });
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "重置账户数据" }, deps, state);
    const cancelled = await runWeChatBridgeTurn({ peerId: "owner", text: "取消" }, deps, state);

    expect(cancelled.reply).toContain("已取消");
    expect(execute).not.toHaveBeenCalled();
    expect(state.pending.has("owner")).toBe(false);
  });

  it("pings progress for an analysis turn but not for a greeting", async () => {
    const analysisProgress = vi.fn();
    await runWeChatBridgeTurn(
      { peerId: "owner", text: "我仓位重不重？" },
      makeDeps({ onProgress: analysisProgress }),
      createWeChatBridgeState(),
    );
    expect(analysisProgress).toHaveBeenCalledTimes(1);

    const greetProgress = vi.fn();
    await runWeChatBridgeTurn(
      { peerId: "owner", text: "你好" },
      makeDeps({ onProgress: greetProgress }),
      createWeChatBridgeState(),
    );
    expect(greetProgress).not.toHaveBeenCalled();
  });

  it("blocks destructive ops when not permitted, but still allows questions", async () => {
    const deps = makeDeps({ allowDestructive: () => false });
    const blocked = await runWeChatBridgeTurn(
      { peerId: "owner", text: "清空模拟盘数据" },
      deps,
      createWeChatBridgeState(),
    );
    expect(blocked.reply).toContain("已禁用");
  });

  it("feeds prior turns as history into the next turn (multi-turn referents)", async () => {
    const brain = new CapturingBrain();
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "风华高科怎么样？" }, makeDeps({ brainProvider: brain }), state);
    brain.prompts = []; // only inspect the 2nd turn's prompts
    await runWeChatBridgeTurn({ peerId: "owner", text: "那它的风险呢？" }, makeDeps({ brainProvider: brain }), state);

    const joined = brain.prompts.join("\n");
    expect(joined).toContain("最近对话");
    expect(joined).toContain("风华高科怎么样");
  });

  it("accepts a broadened confirmation like '可以，执行吧'", async () => {
    const execute = vi.fn(() => "done");
    const deps = makeDeps({ executeAction: execute });
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "清除模拟盘数据" }, deps, state);
    const done = await runWeChatBridgeTurn({ peerId: "owner", text: "可以，执行吧" }, deps, state);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(done.reply).toContain("已执行");
  });

  it("notes (not silently) when a pending op is abandoned by an unrelated message", async () => {
    const execute = vi.fn();
    const deps = makeDeps({ executeAction: execute });
    const state = createWeChatBridgeState();

    await runWeChatBridgeTurn({ peerId: "owner", text: "清除模拟盘数据" }, deps, state);
    const next = await runWeChatBridgeTurn({ peerId: "owner", text: "我仓位重不重？" }, deps, state);

    expect(execute).not.toHaveBeenCalled();
    expect(next.reply).toContain("已放弃上一个待确认操作");
    expect(state.pending.has("owner")).toBe(false);
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
