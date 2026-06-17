import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  brainInputSchema,
  type BrainInput,
} from "../../src/domain/brain/index.js";
import {
  BrainProviderError,
  DashScopeQwenProvider,
  type DashScopeFetchInit,
  type DashScopeFetchLike,
  type DashScopeFetchResponse,
} from "../../src/infrastructure/providers/index.js";

const generatedAt = "2026-06-14T02:00:00.000Z";

describe("DashScopeQwenProvider", () => {
  it("throws a clear error when API key is missing", async () => {
    const provider = new DashScopeQwenProvider({
      apiKey: " ",
      fetchImpl: async () => okDashScopeResponse(validDashScopeContent()),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/requires an API key/);
  });

  it("uses non-streaming JSON mode and validates the model output", async () => {
    let capturedUrl = "";
    let capturedInit: DashScopeFetchInit | undefined;
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      model: "qwen-plus",
      now: () => new Date(generatedAt),
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return okDashScopeResponse(validDashScopeContent());
      },
    });
    const baseInput = makeInput();
    const input = brainInputSchema.parse({
      ...baseInput,
      constraints: {
        ...baseInput.constraints,
        toolPermissions: [
          {
            toolName: "search_memory",
            visibility: "read_only",
            canExecute: false,
          },
        ],
      },
    });
    const output = await provider.generate(input, {
      structuredOutputSchema: z
        .object({
          stance: z.literal("neutral"),
          keyPoints: z.array(z.string()).min(1),
        })
        .strict(),
    });
    const body = JSON.parse(capturedInit?.body ?? "{}") as Record<string, unknown>;

    expect(capturedUrl).toContain("/compatible-mode/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    expect(body).toMatchObject({
      model: "qwen-plus",
      response_format: {
        type: "json_object",
      },
      stream: false,
    });
    expect(body).not.toHaveProperty("tools");
    const userMessage = (body.messages as Array<{ role: string; content: string }>)[1]!;
    const userPayload = JSON.parse(userMessage.content) as {
      constraints: {
        toolPermissions: Array<{ canExecute: boolean }>;
      };
    };
    expect(userPayload.constraints.toolPermissions[0]?.canExecute).toBe(false);
    expect(output).toMatchObject({
      requestId: "brain-req-dashscope",
      provider: "dashscope",
      model: "qwen-plus",
      taskType: "pre_market_plan",
      generatedAt,
      confidence: 0.7,
    });
  });

  it.each([
    [401, "Unauthorized", "auth_failed"],
    [403, "Forbidden", "auth_failed"],
    [429, "Too Many Requests", "rate_limited"],
    [500, "Internal Server Error", "server_error"],
    [503, "Service Unavailable", "server_error"],
  ])("maps HTTP %s to a clear provider error", async (status, statusText, code) => {
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        response({
          ok: false,
          status,
          statusText,
          text: JSON.stringify({
            error: {
              message: `${code} mock`,
            },
          }),
        }),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(code);
  });

  it("handles request timeouts with AbortController", async () => {
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      timeoutMs: 1,
      fetchImpl: hangingFetch(),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/timed out/);
  });

  it("rejects empty responses, bad HTTP JSON, bad message JSON, and bad schema", async () => {
    await expect(
      providerWithText("").generate(makeInput()),
    ).rejects.toThrow(/empty HTTP response/);

    await expect(
      providerWithText("{").generate(makeInput()),
    ).rejects.toThrow(/HTTP response was not valid JSON/);

    await expect(
      providerWithText(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "{",
              },
            },
          ],
        }),
      ).generate(makeInput()),
    ).rejects.toThrow(/message content was not valid JSON/);

    await expect(
      providerWithText(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "",
                  structured: {},
                  confidence: 2,
                }),
              },
            },
          ],
        }),
      ).generate(makeInput()),
    ).rejects.toThrow(/local schema validation/);
  });

  it("rejects responses without model message content", async () => {
    await expect(
      providerWithText(
        JSON.stringify({
          choices: [],
        }),
      ).generate(makeInput()),
    ).rejects.toThrow(/did not contain message content/);
  });

  it("applies caller supplied structured output schema validation", async () => {
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      now: () => new Date(generatedAt),
      fetchImpl: async () => okDashScopeResponse(validDashScopeContent()),
    });

    await expect(
      provider.generate(makeInput(), {
        structuredOutputSchema: z.object({
          mustNotExist: z.string(),
        }),
      }),
    ).rejects.toThrow(/local schema validation/);
  });

  it("rejects executable tool permissions before calling fetch", async () => {
    let calls = 0;
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      fetchImpl: async () => {
        calls += 1;
        return okDashScopeResponse(validDashScopeContent());
      },
    });
    const unsafeInput = {
      ...makeInput(),
      constraints: {
        toolPermissions: [
          {
            toolName: "execute_order",
            visibility: "propose_only",
            canExecute: true,
          },
        ],
      },
    } as unknown as BrainInput;

    await expect(provider.generate(unsafeInput)).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("rejects output identity mismatches", async () => {
    const provider = new DashScopeQwenProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        okDashScopeResponse(
          JSON.stringify({
            ...validBrainOutput(),
            provider: "openai",
          }),
        ),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/provider must be dashscope/);
  });
});

function makeInput(overrides: Partial<BrainInput> = {}): BrainInput {
  return brainInputSchema.parse({
    requestId: "brain-req-dashscope",
    taskType: "pre_market_plan",
    prompt: "Build a pre-market plan. Return JSON.",
    context: {
      accountId: "paper-main",
      cash: 20000,
    },
    ...overrides,
  });
}

function validBrainOutput(): Record<string, unknown> {
  return {
    requestId: "brain-req-dashscope",
    provider: "dashscope",
    model: "qwen-plus",
    taskType: "pre_market_plan",
    generatedAt,
    summary: "DashScope mock pre-market plan.",
    structured: {
      stance: "neutral",
      keyPoints: ["Use deterministic risk boundaries."],
    },
    citations: [],
    confidence: 0.7,
    proposals: [],
  };
}

function validDashScopeContent(): string {
  return JSON.stringify(validBrainOutput());
}

function okDashScopeResponse(content: string): DashScopeFetchResponse {
  return response({
    ok: true,
    status: 200,
    text: JSON.stringify({
      id: "chatcmpl-mock",
      choices: [
        {
          message: {
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180,
      },
    }),
  });
}

function providerWithText(text: string): DashScopeQwenProvider {
  return new DashScopeQwenProvider({
    apiKey: "test-key",
    fetchImpl: async () =>
      response({
        ok: true,
        status: 200,
        text,
      }),
  });
}

function response(input: {
  ok: boolean;
  status: number;
  statusText?: string;
  text: string;
}): DashScopeFetchResponse {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    text: async () => input.text,
  };
}

function hangingFetch(): DashScopeFetchLike {
  return async (_url, init) =>
    new Promise<DashScopeFetchResponse>((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (init?.signal?.aborted) {
        rejectAbort();
        return;
      }

      init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
}
