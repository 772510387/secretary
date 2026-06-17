import {
  brainInputSchema,
  validateBrainOutput,
  type BrainGenerateOptions,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
} from "../../domain/brain/index.js";
import { BrainProviderError } from "./errors.js";
import { requireBrainProviderApiKey } from "./brain-provider-credentials.js";
import {
  normalizeBrainCitations,
  normalizeBrainProposals,
} from "./brain-output-normalize.js";

export interface OpenAIProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: OpenAIFetchLike;
  now?: () => Date;
  temperature?: number;
  maxTokens?: number;
  organization?: string;
  project?: string;
}

export interface OpenAIFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface OpenAIFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type OpenAIFetchLike = (
  input: string,
  init?: OpenAIFetchInit,
) => Promise<OpenAIFetchResponse>;

interface OpenAIChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    code?: string;
    message?: string;
    type?: string;
  };
}

const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_TIMEOUT_MS = 30_000;

export class OpenAIProvider implements BrainProvider {
  readonly providerName = "openai" as const;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: OpenAIFetchLike;
  private readonly now: () => Date;
  private readonly temperature: number;
  private readonly maxTokens: number | undefined;
  private readonly organization: string | undefined;
  private readonly project: string | undefined;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_OPENAI_ENDPOINT;
    this.model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens;
    this.organization = options.organization ?? process.env.OPENAI_ORGANIZATION;
    this.project = options.project ?? process.env.OPENAI_PROJECT;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const parsedInput = brainInputSchema.parse(input);
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const response = await this.fetchCompletion(apiKey, parsedInput);
    const content = extractOpenAIMessageContent(response);
    const rawContent = parseOpenAIContentJson(content);
    const candidate = this.toBrainOutputCandidate(rawContent, parsedInput);
    const output = this.validateCandidate(candidate, options);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  private async fetchCompletion(
    apiKey: string,
    input: BrainInput,
  ): Promise<OpenAIChatCompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.buildHeaders(apiKey),
        body: JSON.stringify(this.buildRequestBody(input)),
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, text);
      }

      if (text.trim() === "") {
        throw new BrainProviderError("OpenAIProvider returned an empty HTTP response");
      }

      const parsed = parseHttpJson(text);

      if (parsed.error) {
        throw new BrainProviderError(
          `OpenAIProvider returned provider error ${parsed.error.code ?? "unknown"}: ${
            parsed.error.message ?? parsed.error.type ?? "no message"
          }`,
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof BrainProviderError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new BrainProviderError(
          `OpenAIProvider request timed out after ${this.timeoutMs}ms`,
          { cause: error },
        );
      }

      throw new BrainProviderError(`OpenAIProvider request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(this.organization === undefined || this.organization.trim() === ""
        ? {}
        : { "OpenAI-Organization": this.organization.trim() }),
      ...(this.project === undefined || this.project.trim() === ""
        ? {}
        : { "OpenAI-Project": this.project.trim() }),
    };
  }

  private buildRequestBody(input: BrainInput): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        {
          role: "developer",
          content: [
            "You are Secretary's OpenAI brain provider adapter.",
            "Return one valid JSON object matching the BrainOutput contract.",
            "Do not execute tools, do not place orders, do not write accounts, and do not overwrite rules.",
            "Any trade or memory write idea must remain a review-required proposal.",
          ].join(" "),
        },
        {
          role: "user",
          content: JSON.stringify({
            requestId: input.requestId,
            taskType: input.taskType,
            prompt: input.prompt,
            context: input.context,
            constraints: input.constraints,
            outputContract: {
              requestId: input.requestId,
              provider: this.providerName,
              model: this.model,
              taskType: input.taskType,
              requiredFields: [
                "summary",
                "structured",
                "citations",
                "confidence",
                "proposals",
              ],
            },
          }),
        },
      ],
      response_format: {
        type: "json_object",
      },
      stream: false,
      store: false,
      temperature: this.temperature,
      ...(this.maxTokens === undefined ? {} : { max_completion_tokens: this.maxTokens }),
    };
  }

  private toBrainOutputCandidate(rawContent: unknown, input: BrainInput): unknown {
    if (typeof rawContent !== "object" || rawContent === null || Array.isArray(rawContent)) {
      throw new BrainProviderError("OpenAIProvider message content must be a JSON object");
    }

    const record = rawContent as Record<string, unknown>;

    return {
      ...record,
      requestId: record.requestId ?? input.requestId,
      provider: record.provider ?? this.providerName,
      model: record.model ?? this.model,
      taskType: record.taskType ?? input.taskType,
      generatedAt: record.generatedAt ?? this.isoNow(),
      citations: normalizeBrainCitations(record.citations),
      proposals: normalizeBrainProposals(record.proposals),
    };
  }

  private validateCandidate(candidate: unknown, options: BrainGenerateOptions): BrainOutput {
    try {
      return validateBrainOutput(candidate, options.structuredOutputSchema);
    } catch (error) {
      throw new BrainProviderError(
        `OpenAIProvider output failed local schema validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private assertMatchesInput(input: BrainInput, output: BrainOutput): void {
    if (output.requestId !== input.requestId) {
      throw new BrainProviderError(
        `OpenAIProvider output requestId ${output.requestId} does not match input ${input.requestId}`,
      );
    }

    if (output.taskType !== input.taskType) {
      throw new BrainProviderError(
        `OpenAIProvider output taskType ${output.taskType} does not match input ${input.taskType}`,
      );
    }

    if (output.provider !== this.providerName) {
      throw new BrainProviderError(
        `OpenAIProvider output provider must be ${this.providerName}, got ${output.provider}`,
      );
    }
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BrainProviderError("OpenAIProvider now() returned an invalid Date");
    }

    return value.toISOString();
  }

  private errorForStatus(
    status: number,
    statusText: string | undefined,
    text: string,
  ): BrainProviderError {
    const detail = extractProviderErrorMessage(text);
    const statusLabel = `${status} ${statusText ?? ""}`.trim();

    if (status === 401 || status === 403) {
      return new BrainProviderError(`OpenAIProvider auth_failed: ${statusLabel}${detail}`);
    }

    if (status === 429) {
      return new BrainProviderError(`OpenAIProvider rate_limited: ${statusLabel}${detail}`);
    }

    if (status >= 500) {
      return new BrainProviderError(`OpenAIProvider server_error: ${statusLabel}${detail}`);
    }

    return new BrainProviderError(`OpenAIProvider request failed: ${statusLabel}${detail}`);
  }
}

function parseHttpJson(text: string): OpenAIChatCompletionResponse {
  try {
    return JSON.parse(text) as OpenAIChatCompletionResponse;
  } catch (error) {
    throw new BrainProviderError("OpenAIProvider HTTP response was not valid JSON", {
      cause: error,
    });
  }
}

function extractOpenAIMessageContent(response: OpenAIChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new BrainProviderError("OpenAIProvider response did not contain message content");
  }

  return content;
}

function parseOpenAIContentJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new BrainProviderError("OpenAIProvider message content was not valid JSON", {
      cause: error,
    });
  }
}

function extractProviderErrorMessage(text: string): string {
  if (text.trim() === "") {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: string } };
    const message = parsed.error?.message ?? parsed.error?.code;
    return message ? ` - ${message}` : "";
  } catch {
    return ` - ${text.slice(0, 200)}`;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}
