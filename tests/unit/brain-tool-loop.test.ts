import { describe, expect, it } from "vitest";
import {
  runAgentToolLoop,
  type AgentMessage,
  type AgentToolExecutor,
  type AgentToolStep,
  type ChatWithToolsRequest,
  type ToolCallingProvider,
} from "../../src/domain/brain/index.js";

/** A provider that replays a fixed list of steps and records the last request. */
function scriptedProvider(steps: AgentToolStep[]): ToolCallingProvider & { last?: ChatWithToolsRequest } {
  const state: { last?: ChatWithToolsRequest } = {};
  let i = 0;
  return {
    providerName: "mock",
    last: undefined,
    async chatWithTools(request: ChatWithToolsRequest): Promise<AgentToolStep> {
      state.last = request;
      (this as { last?: ChatWithToolsRequest }).last = request;
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return step;
    },
  };
}

const baseMessages: AgentMessage[] = [
  { role: "system", content: "你是大脑" },
  { role: "user", content: "买点茅台" },
];

describe("runAgentToolLoop", () => {
  it("executes a tool then returns the final answer with effects collected", async () => {
    const steps: AgentToolStep[] = [
      { content: "", toolCalls: [{ id: "c1", name: "paper_buy", arguments: '{"symbol":"600519"}' }] },
      { content: "已完成买入。", toolCalls: [] },
    ];
    const execute: AgentToolExecutor = async (call) => {
      expect(call.name).toBe("paper_buy");
      return {
        content: JSON.stringify({ ok: true }),
        effect: { kind: "paper_buy", mutated: true, summary: "买入 600519：已成交" },
      };
    };

    const result = await runAgentToolLoop({
      provider: scriptedProvider(steps),
      messages: baseMessages,
      tools: [],
      execute,
    });

    expect(result.answer).toBe("已完成买入。");
    expect(result.stoppedReason).toBe("completed");
    expect(result.iterations).toBe(2);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]!.mutated).toBe(true);
    // The transcript must include the assistant tool-call message and a tool result.
    expect(result.messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
  });

  it("stops at the iteration cap when the model never stops calling tools", async () => {
    const provider: ToolCallingProvider = {
      providerName: "mock",
      async chatWithTools(): Promise<AgentToolStep> {
        return { content: "", toolCalls: [{ id: "c", name: "noop", arguments: "{}" }] };
      },
    };
    const result = await runAgentToolLoop({
      provider,
      messages: baseMessages,
      tools: [],
      execute: async () => ({ content: "{}" }),
      maxIterations: 3,
    });

    expect(result.stoppedReason).toBe("max_iterations");
    expect(result.iterations).toBe(3);
  });

  it("reports a thrown tool back to the model instead of aborting the turn", async () => {
    const steps: AgentToolStep[] = [
      { content: "", toolCalls: [{ id: "c1", name: "paper_buy", arguments: "{}" }] },
      { content: "我调整一下。", toolCalls: [] },
    ];
    const execute: AgentToolExecutor = async () => {
      throw new Error("boom");
    };

    const result = await runAgentToolLoop({
      provider: scriptedProvider(steps),
      messages: baseMessages,
      tools: [],
      execute,
    });

    expect(result.answer).toBe("我调整一下。");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("boom");
  });

  it("drains steering messages before the model step (B1)", async () => {
    const provider = scriptedProvider([{ content: "好的", toolCalls: [] }]);
    let drained = false;
    const result = await runAgentToolLoop({
      provider,
      messages: [{ role: "user", content: "在吗" }],
      tools: [],
      execute: async () => ({ content: "{}" }),
      drainSteering: () => {
        if (drained) {
          return [];
        }
        drained = true;
        return [{ role: "system", content: "【小脑红线】已触发8%止损并平仓" }];
      },
    });

    expect(provider.last?.messages.some((m) => m.content.includes("8%止损"))).toBe(true);
    expect(result.answer).toBe("好的");
  });

  it("returns aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runAgentToolLoop({
      provider: scriptedProvider([{ content: "x", toolCalls: [] }]),
      messages: baseMessages,
      tools: [],
      execute: async () => ({ content: "{}" }),
      signal: controller.signal,
    });

    expect(result.stoppedReason).toBe("aborted");
    expect(result.iterations).toBe(0);
  });
});
