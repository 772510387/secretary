import { describe, expect, it } from "vitest";
import { handleAgentHttpTurn } from "../../src/interfaces/agent-http.js";
import {
  createWeChatBridgeState,
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

function deps(): WeChatBridgeDependencies {
  return {
    brainProvider: new StubBrain(),
    isAllowed: () => true,
    allowDestructive: () => true,
    loadContext: () => ({ account: makeAccount(), positions: [] }),
    executeAction: () => "ok",
  };
}

describe("handleAgentHttpTurn", () => {
  it("returns a reply for a valid request", async () => {
    const result = await handleAgentHttpTurn(
      { peerId: "owner", text: "我仓位怎么样？" },
      deps(),
      createWeChatBridgeState(),
    );
    expect(result.status).toBe(200);
    expect(result.body.reply).toBe("模型回答。");
  });

  it("400s when peerId is missing", async () => {
    const result = await handleAgentHttpTurn({ text: "x" }, deps(), createWeChatBridgeState());
    expect(result.status).toBe(400);
  });

  it("400s when the body is not an object", async () => {
    const result = await handleAgentHttpTurn("oops", deps(), createWeChatBridgeState());
    expect(result.status).toBe(400);
  });

  it("carries confirmation state across requests (same state object)", async () => {
    const d = deps();
    const state = createWeChatBridgeState();

    const prompt = await handleAgentHttpTurn({ peerId: "owner", text: "清除模拟盘数据" }, d, state);
    expect(String(prompt.body.reply)).toContain("确认");

    const done = await handleAgentHttpTurn({ peerId: "owner", text: "确认" }, d, state);
    expect(String(done.body.reply)).toContain("已执行");
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
