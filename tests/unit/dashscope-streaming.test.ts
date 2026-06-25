import { describe, expect, it, vi } from "vitest";
import {
  DashScopeQwenProvider,
  type DashScopeFetchLike,
  type DashScopeFetchResponse,
} from "../../src/infrastructure/providers/index.js";
import { type BrainInput } from "../../src/domain/brain/index.js";

const now = "2026-06-24T01:00:00.000Z";

function input(): BrainInput {
  return {
    requestId: "req-stream-1",
    taskType: "user_query",
    prompt: "当前持仓怎么样",
    context: {},
    constraints: { locale: "zh-CN", timezone: "Asia/Shanghai", outputFormat: "json", toolPermissions: [] },
    createdAt: now,
  };
}

/** A valid BrainOutput JSON the model would return, split into SSE content deltas. */
function brainOutputJson(): string {
  return JSON.stringify({
    requestId: "req-stream-1",
    provider: "dashscope",
    model: "qwen-plus",
    taskType: "user_query",
    generatedAt: now,
    summary: "持仓稳健。",
    structured: { ok: true },
    citations: [],
    confidence: 0.6,
    proposals: [],
  });
}

function sseResponse(deltas: string[]): DashScopeFetchResponse {
  const chunks = [
    ...deltas.map(
      (delta) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta }, finish_reason: null }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
  return { ok: true, status: 200, text: async () => chunks.join(""), body };
}

describe("DashScopeQwenProvider.generateStream", () => {
  it("accumulates SSE content deltas into a validated BrainOutput", async () => {
    const full = brainOutputJson();
    const deltas = [full.slice(0, 20), full.slice(20, 60), full.slice(60)];
    const fetchImpl: DashScopeFetchLike = async () => sseResponse(deltas);
    const onProgress = vi.fn();

    const provider = new DashScopeQwenProvider({ apiKey: "k", fetchImpl, now: () => new Date(now) });
    const output = await provider.generateStream(input(), { onProgress });

    expect(output.summary).toBe("持仓稳健。");
    expect(output.provider).toBe("dashscope");
    expect(onProgress).toHaveBeenCalled();
  });

  it("falls back to non-streaming parse when the response has no byte stream (mock)", async () => {
    // A mock that only implements text() returning a full chat-completion JSON.
    const completion = JSON.stringify({
      choices: [{ message: { content: brainOutputJson() }, finish_reason: "stop" }],
    });
    const fetchImpl: DashScopeFetchLike = async () => ({ ok: true, status: 200, text: async () => completion });

    const provider = new DashScopeQwenProvider({ apiKey: "k", fetchImpl, now: () => new Date(now) });
    const output = await provider.generateStream(input());

    expect(output.summary).toBe("持仓稳健。");
  });

  it("idle-times out when the stream stalls with no chunk", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: DashScopeFetchLike = async (_url, init) =>
        ({
          ok: true,
          status: 200,
          text: async () => "",
          // A body that never produces a chunk; read() rejects when aborted.
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")));
            },
          }),
        }) as DashScopeFetchResponse;

      const provider = new DashScopeQwenProvider({
        apiKey: "k",
        fetchImpl,
        idleTimeoutMs: 5_000,
        maxRetries: 0,
        now: () => new Date(now),
      });
      const promise = provider.generateStream(input());
      const assertion = expect(promise).rejects.toThrow(/idle-timed out/);
      await vi.advanceTimersByTimeAsync(6_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
