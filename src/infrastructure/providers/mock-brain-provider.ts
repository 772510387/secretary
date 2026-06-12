import {
  brainInputSchema,
  validateBrainOutput,
  type BrainGenerateOptions,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
} from "../../domain/brain/index.js";
import type { JsonValue } from "../../domain/shared/index.js";
import { BrainProviderError } from "./errors.js";

export interface MockBrainProviderOptions {
  model?: string;
  now?: () => Date;
  responseFactory?: MockBrainResponseFactory;
}

export type MockBrainResponseFactory = (
  input: BrainInput,
) => BrainOutput | Promise<BrainOutput> | unknown | Promise<unknown>;

export class MockBrainProvider implements BrainProvider {
  readonly providerName = "mock" as const;
  private readonly model: string;
  private readonly now: () => Date;
  private readonly responseFactory?: MockBrainResponseFactory;

  constructor(options: MockBrainProviderOptions = {}) {
    this.model = options.model ?? "mock-brain-v1";
    this.now = options.now ?? (() => new Date());
    this.responseFactory = options.responseFactory;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const parsedInput = brainInputSchema.parse(input);
    const candidate = this.responseFactory
      ? await this.responseFactory(parsedInput)
      : this.defaultResponse(parsedInput);
    const output = validateBrainOutput(candidate, options.structuredOutputSchema);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  private defaultResponse(input: BrainInput): BrainOutput {
    const generatedAt = this.isoNow();
    const structured = buildMockStructuredOutput(input);

    return validateBrainOutput({
      requestId: input.requestId,
      provider: this.providerName,
      model: this.model,
      taskType: input.taskType,
      generatedAt,
      summary: mockSummaryForTask(input),
      structured,
      citations: [
        {
          title: "Mock brain deterministic context",
          sourceType: "system",
          note: "Generated locally without calling a real model provider.",
        },
      ],
      confidence: 0.5,
      proposals: [],
    });
  }

  private assertMatchesInput(input: BrainInput, output: BrainOutput): void {
    if (output.requestId !== input.requestId) {
      throw new BrainProviderError(
        `MockBrainProvider output requestId ${output.requestId} does not match input ${input.requestId}`,
      );
    }

    if (output.taskType !== input.taskType) {
      throw new BrainProviderError(
        `MockBrainProvider output taskType ${output.taskType} does not match input ${input.taskType}`,
      );
    }

    if (output.provider !== this.providerName) {
      throw new BrainProviderError(
        `MockBrainProvider output provider must be ${this.providerName}, got ${output.provider}`,
      );
    }
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BrainProviderError("MockBrainProvider now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

function mockSummaryForTask(input: BrainInput): string {
  switch (input.taskType) {
    case "pre_market_plan":
      return "Mock pre-market plan generated from deterministic context.";
    case "midday_review":
      return "Mock midday review generated from deterministic context.";
    case "closing_review":
      return "Mock closing review generated from deterministic context.";
    case "daily_reflection":
      return "Mock daily reflection generated from deterministic context.";
    case "news_explanation":
      return "Mock news explanation generated from deterministic context.";
    case "trade_idea":
      return "Mock trade idea generated as a non-executable draft.";
    case "memory_proposal":
      return "Mock memory proposal generated as a review-required draft.";
    case "user_query":
      return "Mock user query answer generated from deterministic context.";
    case "research_summary":
      return "Mock research summary generated from deterministic context.";
  }
}

function buildMockStructuredOutput(input: BrainInput): JsonValue {
  return {
    taskType: input.taskType,
    stance: "neutral",
    keyPoints: [
      "This is a deterministic mock response.",
      "No real model provider was called.",
    ],
    riskWarnings: [
      "This output is not an order.",
      "Any trade idea must pass policy and risk checks.",
    ],
    nextActions: [],
    contextDigest: digestJson(input.context),
  };
}

function digestJson(value: JsonValue): string {
  const serialized = JSON.stringify(value);
  return serialized.length <= 200 ? serialized : `${serialized.slice(0, 197)}...`;
}
