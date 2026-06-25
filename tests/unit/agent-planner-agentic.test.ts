import { describe, expect, it, vi } from "vitest";
import {
  buildPaperAgentTools,
  createWeChatBridgeState,
  fulfilTurnPlan,
  runWeChatBridgeTurn,
  type PaperAgentToolDeps,
  type PaperPortfolioView,
  type WeChatBridgeDependencies,
} from "../../src/app/index.js";
import type { Account } from "../../src/domain/portfolio/index.js";
import type { AgentToolStep, ToolCallingProvider } from "../../src/domain/brain/index.js";

const now = "2026-06-24T01:00:00.000Z";

// The agentic chat path only reads account.accountId; a minimal stub avoids schema coupling.
const account = { accountId: "paper-1" } as unknown as Account;

const portfolio: PaperPortfolioView = {
  accountId: "paper-1",
  availableCash: 100_000,
  totalCash: 100_000,
  totalAssets: 100_000,
  totalPositionMarketValue: 0,
  totalUnrealizedPnl: 0,
  investedRatio: 0,
  positions: [],
  pricesAvailable: true,
};

function toolDeps(): PaperAgentToolDeps {
  return {
    loadPortfolio: () => portfolio,
    getQuote: () => ({ symbol: "600519", price: 1700 }),
    executePaperOrder: () => ({ status: "filled", quantity: 100, limitPrice: 1700 }),
  };
}

/** A tool-calling provider that buys then answers. */
function buyingProvider(): ToolCallingProvider {
  const steps: AgentToolStep[] = [
    { content: "", toolCalls: [{ id: "c1", name: "paper_buy", arguments: '{"symbol":"600519","reason":"放量突破"}' }] },
    { content: "已建仓茅台 100 股，逻辑：放量突破。", toolCalls: [] },
  ];
  let i = 0;
  return {
    providerName: "mock",
    async chatWithTools(): Promise<AgentToolStep> {
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return step;
    },
  };
}

describe("fulfilTurnPlan chat (agentic)", () => {
  it("routes chat through the tool loop and surfaces the executed operation", async () => {
    const result = await fulfilTurnPlan(
      { intent: "chat", requiresConfirmation: false },
      { message: "看看茅台，合适就买点", account, positions: [], now },
      { brainProvider: { providerName: "mock", generate: async () => { throw new Error("unused"); } }, agentTools: buildPaperAgentTools(toolDeps()), toolProvider: buyingProvider() },
    );

    expect(result.intent).toBe("chat");
    expect(result.reply).toContain("已建仓");
    expect(result.operations).toHaveLength(1);
    expect(result.operationNotification).toBeDefined();
    expect(result.operationNotification!.metadata.executed).toBe(true);
  });
});

describe("runWeChatBridgeTurn (agentic chat)", () => {
  it("pushes the model-executed operation to external channels", async () => {
    const pushOperation = vi.fn();
    const deps: WeChatBridgeDependencies = {
      brainProvider: { providerName: "mock", generate: async () => { throw new Error("unused"); } },
      agentTools: buildPaperAgentTools(toolDeps()),
      toolProvider: buyingProvider(),
      isAllowed: () => true,
      allowDestructive: () => true,
      loadContext: () => ({ account, positions: [] }),
      executeAction: () => "noop",
      pushOperation,
      now: () => new Date(now),
    };

    const reply = await runWeChatBridgeTurn(
      { peerId: "boss", text: "看看茅台，合适就买点" },
      deps,
      createWeChatBridgeState(),
    );

    expect(reply.reply).toContain("已建仓");
    expect(pushOperation).toHaveBeenCalledOnce();
  });
});
