import { describe, expect, it } from "vitest";
import {
  DashScopeQwenProvider,
  type DashScopeFetchLike,
  type DashScopeFetchResponse,
} from "../../src/infrastructure/providers/index.js";
import type { AgentToolSpec } from "../../src/domain/brain/index.js";

const now = "2026-06-24T01:00:00.000Z";

const tools: AgentToolSpec[] = [
  { name: "paper_buy", description: "买入", parameters: { type: "object", properties: {} } },
];

function sseResponse(lines: string[]): DashScopeFetchResponse {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < lines.length) {
        controller.enqueue(encoder.encode(lines[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return { ok: true, status: 200, text: async () => lines.join(""), body };
}

function dataLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("DashScopeQwenProvider.chatWithTools", () => {
  it("reassembles streamed tool_call deltas into a whole tool call", async () => {
    const lines = [
      dataLine({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "paper_buy", arguments: "" } }] }, finish_reason: null }],
      }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"symbol":' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"600519","reason":"突破"}' } }] }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "data: [DONE]\n\n",
    ];
    const fetchImpl: DashScopeFetchLike = async () => sseResponse(lines);
    const provider = new DashScopeQwenProvider({ apiKey: "k", fetchImpl, now: () => new Date(now) });

    const step = await provider.chatWithTools({ messages: [{ role: "user", content: "买茅台" }], tools });

    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]!.id).toBe("call_1");
    expect(step.toolCalls[0]!.name).toBe("paper_buy");
    expect(JSON.parse(step.toolCalls[0]!.arguments)).toEqual({ symbol: "600519", reason: "突破" });
    expect(step.finishReason).toBe("tool_calls");
  });

  it("accumulates a plain text answer when no tools are called", async () => {
    const lines = [
      dataLine({ choices: [{ delta: { content: "持仓" }, finish_reason: null }] }),
      dataLine({ choices: [{ delta: { content: "稳健。" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ];
    const fetchImpl: DashScopeFetchLike = async () => sseResponse(lines);
    const provider = new DashScopeQwenProvider({ apiKey: "k", fetchImpl, now: () => new Date(now) });

    const step = await provider.chatWithTools({ messages: [{ role: "user", content: "怎么样" }], tools });

    expect(step.content).toBe("持仓稳健。");
    expect(step.toolCalls).toHaveLength(0);
  });

  it("falls back to a non-streaming parse when the response has no byte stream (mock)", async () => {
    const completion = JSON.stringify({
      choices: [
        {
          message: { content: "", tool_calls: [{ id: "c", function: { name: "get_portfolio", arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    const fetchImpl: DashScopeFetchLike = async () => ({ ok: true, status: 200, text: async () => completion });
    const provider = new DashScopeQwenProvider({ apiKey: "k", fetchImpl, now: () => new Date(now) });

    const step = await provider.chatWithTools({ messages: [{ role: "user", content: "看看账户" }], tools });

    expect(step.toolCalls).toHaveLength(1);
    expect(step.toolCalls[0]!.name).toBe("get_portfolio");
  });
});
