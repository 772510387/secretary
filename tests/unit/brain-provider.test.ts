import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BrainValidationError,
  brainInputSchema,
  validateBrainOutput,
  type BrainInput,
} from "../../src/domain/brain/index.js";
import {
  BrainProviderError,
  MockBrainProvider,
  requireBrainProviderApiKey,
} from "../../src/infrastructure/providers/index.js";

const generatedAt = "2026-06-12T08:00:00.000Z";

describe("Brain domain schemas", () => {
  it("parses brain input with safe defaults", () => {
    const input = brainInputSchema.parse({
      requestId: "brain-req-001",
      taskType: "pre_market_plan",
      prompt: "Build a pre-market plan.",
    });

    expect(input.context).toEqual({});
    expect(input.constraints).toMatchObject({
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      toolPermissions: [],
    });
  });

  it("rejects executable tool permissions", () => {
    expect(() =>
      brainInputSchema.parse({
        requestId: "brain-req-002",
        taskType: "user_query",
        prompt: "Can you trade?",
        constraints: {
          toolPermissions: [
            {
              toolName: "broker.submitOrder",
              canExecute: true,
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("rejects non-review trade proposals", () => {
    expect(() =>
      validateBrainOutput({
        requestId: "brain-req-003",
        provider: "mock",
        model: "mock-brain-v1",
        taskType: "trade_idea",
        generatedAt,
        summary: "Draft only.",
        structured: {},
        confidence: 0.4,
        proposals: [
          {
            proposalId: "proposal-001",
            type: "trade_intent_draft",
            title: "Buy draft",
            rationale: "Testing",
            payload: {
              symbol: "000636",
            },
            requiresReview: false,
          },
        ],
      }),
    ).toThrow(BrainValidationError);
  });
});

describe("MockBrainProvider", () => {
  it("returns deterministic structured output and validates it", async () => {
    const provider = new MockBrainProvider({
      now: () => new Date(generatedAt),
    });
    const structuredSchema = z
      .object({
        taskType: z.literal("pre_market_plan"),
        stance: z.literal("neutral"),
        keyPoints: z.array(z.string()).min(1),
        riskWarnings: z.array(z.string()).min(1),
        nextActions: z.array(z.unknown()),
        contextDigest: z.string(),
      })
      .strict();

    const output = await provider.generate(makeInput(), {
      structuredOutputSchema: structuredSchema,
    });

    expect(output).toMatchObject({
      requestId: "brain-req-010",
      provider: "mock",
      model: "mock-brain-v1",
      taskType: "pre_market_plan",
      generatedAt,
      confidence: 0.5,
    });
    expect(output.summary).toContain("Mock pre-market plan");
    expect(output.proposals).toEqual([]);
    expect(output.citations[0]).toMatchObject({
      sourceType: "system",
    });
  });

  it("rejects invalid provider output before callers can use it", async () => {
    const provider = new MockBrainProvider({
      now: () => new Date(generatedAt),
      responseFactory: () => ({
        requestId: "brain-req-010",
        provider: "mock",
        model: "mock-brain-v1",
        taskType: "pre_market_plan",
        generatedAt,
        summary: "",
        structured: {},
        confidence: 2,
      }),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(BrainValidationError);
  });

  it("rejects provider output that does not match the request", async () => {
    const provider = new MockBrainProvider({
      now: () => new Date(generatedAt),
      responseFactory: () => ({
        requestId: "other-request",
        provider: "mock",
        model: "mock-brain-v1",
        taskType: "pre_market_plan",
        generatedAt,
        summary: "Valid but mismatched.",
        structured: {},
        confidence: 0.5,
      }),
    });

    await expect(provider.generate(makeInput())).rejects.toThrow(BrainProviderError);
  });

  it("uses the optional structured output schema", async () => {
    const provider = new MockBrainProvider({
      now: () => new Date(generatedAt),
    });

    await expect(
      provider.generate(makeInput(), {
        structuredOutputSchema: z.object({
          mustNotExist: z.string(),
        }),
      }),
    ).rejects.toThrow(BrainValidationError);
  });
});

describe("Brain provider credentials", () => {
  it("throws a clear error when a real provider API key is missing", () => {
    expect(() => requireBrainProviderApiKey("dashscope", undefined)).toThrow(BrainProviderError);
    expect(() => requireBrainProviderApiKey("openai", "   ")).toThrow(/requires an API key/);
    expect(requireBrainProviderApiKey("gemini", " key-123 ")).toBe("key-123");
  });
});

function makeInput(overrides: Partial<BrainInput> = {}): BrainInput {
  return brainInputSchema.parse({
    requestId: "brain-req-010",
    taskType: "pre_market_plan",
    prompt: "Build a pre-market plan.",
    context: {
      accountId: "paper-main",
      cash: 20000,
    },
    ...overrides,
  });
}
