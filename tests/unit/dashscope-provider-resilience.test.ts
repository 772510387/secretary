import { describe, expect, it } from "vitest";
import { brainInputSchema } from "../../src/domain/brain/index.js";
import {
  DashScopeQwenProvider,
  type DashScopeFetchResponse,
} from "../../src/infrastructure/providers/index.js";

const input = brainInputSchema.parse({
  requestId: "req-1",
  taskType: "user_query",
  prompt: "hi",
});

function okResponse(finishReason = "stop"): DashScopeFetchResponse {
  const body = {
    choices: [
      {
        message: { content: JSON.stringify({ summary: "ok", structured: {}, confidence: 0.5 }) },
        finish_reason: finishReason,
      },
    ],
  };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function errorResponse(status: number): DashScopeFetchResponse {
  return {
    ok: false,
    status,
    statusText: "x",
    text: async () => JSON.stringify({ error: { message: "boom" } }),
  };
}

describe("DashScopeQwenProvider resilience", () => {
  it("retries a transient 429 then succeeds", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? errorResponse(429) : okResponse();
      },
    });

    const output = await provider.generate(input);
    expect(calls).toBe(2);
    expect(output.summary).toBe("ok");
  });

  it("retries 5xx up to maxRetries then gives up", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return errorResponse(503);
      },
    });

    await expect(provider.generate(input)).rejects.toThrow(/server_error/);
    expect(calls).toBe(3); // 1 + 2 retries
  });

  it("does NOT retry a non-transient 401", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return errorResponse(401);
      },
    });

    await expect(provider.generate(input)).rejects.toThrow(/auth_failed/);
    expect(calls).toBe(1);
  });

  it("surfaces a clear truncation error when finish_reason=length", async () => {
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      fetchImpl: async () => okResponse("length"),
    });

    await expect(provider.generate(input)).rejects.toThrow(/截断|finish_reason=length/);
  });

  it("retries a transient in-stream error chunk (5xx batching) then succeeds", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      streaming: true,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? sseStreamResponse([TRANSIENT_STREAM_ERROR])
          : sseStreamResponse([GOOD_DELTA, "data: [DONE]"]);
      },
    });

    const output = await provider.generateStream(input);
    expect(calls).toBe(2);
    expect(output.summary).toBe("ok");
  });

  it("does NOT retry a non-transient in-stream error chunk", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "k",
      retryBaseDelayMs: 0,
      streaming: true,
      fetchImpl: async () => {
        calls += 1;
        return sseStreamResponse([
          'data: {"error":{"code":"invalid_request_error","message":"bad params"}}',
        ]);
      },
    });

    await expect(provider.generateStream(input)).rejects.toThrow(/invalid_request/);
    expect(calls).toBe(1);
  });
});

const GOOD_DELTA = `data: {"choices":[{"delta":{"content":${JSON.stringify(
  '{"summary":"ok","structured":{},"confidence":0.5}',
)}},"finish_reason":"stop"}]}`;
const TRANSIENT_STREAM_ERROR =
  'data: {"error":{"code":"internal_server_error","message":"<500> InternalError.Algo: Receive batching backend response failed!"}}';

function sseStreamResponse(lines: string[]): DashScopeFetchResponse {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    text: async () => lines.join("\n"),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    }),
  };
}
