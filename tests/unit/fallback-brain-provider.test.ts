import { describe, expect, it } from "vitest";
import {
  brainInputSchema,
  type BrainGenerateOptions,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
  type BrainProviderName,
} from "../../src/domain/brain/index.js";
import {
  BrainProviderError,
  FallbackBrainProvider,
} from "../../src/infrastructure/providers/index.js";

const generatedAt = "2026-06-16T02:00:00.000Z";

class StubProvider implements BrainProvider {
  calls = 0;

  constructor(
    readonly providerName: BrainProviderName,
    private readonly behavior: "ok" | "fail",
  ) {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.calls += 1;

    if (this.behavior === "fail") {
      throw new BrainProviderError(`${this.providerName} stub failure`);
    }

    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: `${this.providerName}-stub`,
      taskType: input.taskType,
      generatedAt,
      summary: `${this.providerName} stub output`,
      structured: {},
      citations: [],
      confidence: 0.5,
      proposals: [],
    };
  }
}

const input = brainInputSchema.parse({
  requestId: "brain-req-fallback",
  taskType: "user_query",
  prompt: "Confirm reachability.",
});

const noOptions: BrainGenerateOptions = {};

describe("FallbackBrainProvider", () => {
  it("returns the primary output without calling the fallback", async () => {
    const primary = new StubProvider("gemini", "ok");
    const fallback = new StubProvider("dashscope", "ok");
    const provider = new FallbackBrainProvider([primary, fallback]);

    const output = await provider.generate(input, noOptions);

    expect(output.provider).toBe("gemini");
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
  });

  it("falls back to the secondary when the primary fails", async () => {
    const primary = new StubProvider("gemini", "fail");
    const fallback = new StubProvider("dashscope", "ok");
    const attempts: string[] = [];
    const provider = new FallbackBrainProvider([primary, fallback], {
      onAttemptError: (info) => attempts.push(info.providerName),
    });

    const output = await provider.generate(input, noOptions);

    expect(output.provider).toBe("dashscope");
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(attempts).toEqual(["gemini"]);
  });

  it("throws an aggregated error when every provider fails", async () => {
    const primary = new StubProvider("gemini", "fail");
    const fallback = new StubProvider("dashscope", "fail");
    const provider = new FallbackBrainProvider([primary, fallback]);

    await expect(provider.generate(input, noOptions)).rejects.toThrow(
      /All brain providers failed.*gemini.*dashscope/s,
    );
  });

  it("reports the primary provider name", () => {
    const provider = new FallbackBrainProvider([
      new StubProvider("gemini", "ok"),
      new StubProvider("dashscope", "ok"),
    ]);

    expect(provider.providerName).toBe("gemini");
  });

  it("requires at least one provider", () => {
    expect(() => new FallbackBrainProvider([])).toThrow(BrainProviderError);
  });
});
