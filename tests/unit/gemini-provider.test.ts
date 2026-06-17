import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  brainInputSchema,
  type BrainInput,
} from "../../src/domain/brain/index.js";
import {
  GeminiProvider,
  type GeminiFetchInit,
  type GeminiFetchLike,
  type GeminiFetchResponse,
} from "../../src/infrastructure/providers/index.js";

const generatedAt = "2026-06-16T02:00:00.000Z";

describe("GeminiProvider", () => {
  it("throws a clear error when API key is missing", async () => {
    const provider = new GeminiProvider({
      apiKey: " ",
      fetchImpl: async () => okGeminiResponse(validGeminiContent()),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/requires an API key/);
  });

  it("uses native generateContent JSON mode and validates the model output", async () => {
    let capturedUrl = "";
    let capturedInit: GeminiFetchInit | undefined;
    const provider = new GeminiProvider({
      apiKey: "test-key",
      model: "gemini-2.0-flash",
      now: () => new Date(generatedAt),
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return okGeminiResponse(validGeminiContent());
      },
    });
    const output = await provider.generate(makeInput(), {
      structuredOutputSchema: z
        .object({
          stance: z.literal("neutral"),
          keyPoints: z.array(z.string()).min(1),
        })
        .strict(),
    });
    const body = JSON.parse(capturedInit?.body ?? "{}") as Record<string, unknown>;

    expect(capturedUrl).toContain("/models/gemini-2.0-flash:generateContent");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      "x-goog-api-key": "test-key",
      "Content-Type": "application/json",
    });
    expect(body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json",
      },
    });
    expect(body).not.toHaveProperty("tools");
    expect(output).toMatchObject({
      requestId: "brain-req-gemini",
      provider: "gemini",
      model: "gemini-2.0-flash",
      taskType: "pre_market_plan",
      generatedAt,
      confidence: 0.7,
    });
  });

  it.each([
    [400, "Bad Request", "auth_failed", "API key not valid"],
    [401, "Unauthorized", "auth_failed", "unauthorized"],
    [403, "Forbidden", "auth_failed", "permission denied"],
    [429, "Too Many Requests", "rate_limited", "resource exhausted"],
    [500, "Internal Server Error", "server_error", "internal"],
    [503, "Service Unavailable", "server_error", "unavailable"],
  ])("maps HTTP %s to a clear provider error", async (status, statusText, code, message) => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        response({
          ok: false,
          status,
          statusText,
          text: JSON.stringify({ error: { message, status: statusText } }),
        }),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(code);
  });

  it("handles request timeouts with AbortController", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      timeoutMs: 1,
      fetchImpl: hangingFetch(),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/timed out/);
  });

  it("rejects blocked prompts, empty responses, and bad JSON", async () => {
    await expect(
      providerWithText(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })).generate(
        makeInput(),
      ),
    ).rejects.toThrow(/blocked the prompt: SAFETY/);

    await expect(providerWithText("").generate(makeInput())).rejects.toThrow(
      /empty HTTP response/,
    );

    await expect(providerWithText("{").generate(makeInput())).rejects.toThrow(
      /HTTP response was not valid JSON/,
    );

    await expect(
      providerWithText(geminiEnvelope("{")).generate(makeInput()),
    ).rejects.toThrow(/message content was not valid JSON/);
  });

  it("rejects responses without candidate content", async () => {
    await expect(
      providerWithText(JSON.stringify({ candidates: [] })).generate(makeInput()),
    ).rejects.toThrow(/did not contain content/);
  });

  it("rejects output that fails local schema validation", async () => {
    await expect(
      providerWithText(
        geminiEnvelope(
          JSON.stringify({ summary: "", structured: {}, confidence: 2 }),
        ),
      ).generate(makeInput()),
    ).rejects.toThrow(/local schema validation/);
  });

  it("rejects output identity mismatches", async () => {
    const provider = new GeminiProvider({
      apiKey: "test-key",
      fetchImpl: async () =>
        okGeminiResponse(
          JSON.stringify({ ...validBrainOutput(), provider: "openai" }),
        ),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(/provider must be gemini/);
  });
});

function makeInput(overrides: Partial<BrainInput> = {}): BrainInput {
  return brainInputSchema.parse({
    requestId: "brain-req-gemini",
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
    requestId: "brain-req-gemini",
    provider: "gemini",
    model: "gemini-2.0-flash",
    taskType: "pre_market_plan",
    generatedAt,
    summary: "Gemini mock pre-market plan.",
    structured: {
      stance: "neutral",
      keyPoints: ["Use deterministic risk boundaries."],
    },
    citations: [],
    confidence: 0.7,
    proposals: [],
  };
}

function validGeminiContent(): string {
  return JSON.stringify(validBrainOutput());
}

function geminiEnvelope(text: string): string {
  return JSON.stringify({
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason: "STOP",
      },
    ],
  });
}

function okGeminiResponse(content: string): GeminiFetchResponse {
  return response({
    ok: true,
    status: 200,
    text: geminiEnvelope(content),
  });
}

function providerWithText(text: string): GeminiProvider {
  return new GeminiProvider({
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
}): GeminiFetchResponse {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    text: async () => input.text,
  };
}

function hangingFetch(): GeminiFetchLike {
  return async (_url, init) =>
    new Promise<GeminiFetchResponse>((_resolve, reject) => {
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
