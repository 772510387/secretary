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

export interface DashScopeQwenProviderOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: DashScopeFetchLike;
  now?: () => Date;
  temperature?: number;
  maxTokens?: number;
}

export interface DashScopeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface DashScopeFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type DashScopeFetchLike = (
  input: string,
  init?: DashScopeFetchInit,
) => Promise<DashScopeFetchResponse>;

interface DashScopeChatCompletionResponse {
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

const DEFAULT_DASHSCOPE_ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_DASHSCOPE_MODEL = "qwen-plus";
const DEFAULT_TIMEOUT_MS = 30_000;

export class DashScopeQwenProvider implements BrainProvider {
  readonly providerName = "dashscope" as const;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: DashScopeFetchLike;
  private readonly now: () => Date;
  private readonly temperature: number;
  private readonly maxTokens: number | undefined;

  constructor(options: DashScopeQwenProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_DASHSCOPE_ENDPOINT;
    this.model = options.model ?? DEFAULT_DASHSCOPE_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const parsedInput = brainInputSchema.parse(input);
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const response = await this.fetchCompletion(apiKey, parsedInput);
    const content = extractDashScopeMessageContent(response);
    const rawContent = parseDashScopeContentJson(content);
    const candidate = this.toBrainOutputCandidate(rawContent, parsedInput);
    const output = this.validateCandidate(candidate, options);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  private async fetchCompletion(
    apiKey: string,
    input: BrainInput,
  ): Promise<DashScopeChatCompletionResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(this.buildRequestBody(input)),
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, text);
      }

      if (text.trim() === "") {
        throw new BrainProviderError("DashScopeQwenProvider returned an empty HTTP response");
      }

      const parsed = parseHttpJson(text);

      if (parsed.error) {
        throw new BrainProviderError(
          `DashScopeQwenProvider returned provider error ${parsed.error.code ?? "unknown"}: ${
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
          `DashScopeQwenProvider request timed out after ${this.timeoutMs}ms`,
          { cause: error },
        );
      }

      throw new BrainProviderError(`DashScopeQwenProvider request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(input: BrainInput): Record<string, unknown> {
    return {
      model: this.model,
      messages: [
        {
          role: "system",
          content: [
            "You are Secretary's brain provider adapter.",
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
      temperature: this.temperature,
      ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
    };
  }

  private toBrainOutputCandidate(rawContent: unknown, input: BrainInput): unknown {
    if (typeof rawContent !== "object" || rawContent === null || Array.isArray(rawContent)) {
      throw new BrainProviderError("DashScopeQwenProvider message content must be a JSON object");
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

  private validateCandidate(
    candidate: unknown,
    options: BrainGenerateOptions,
  ): BrainOutput {
    try {
      return validateBrainOutput(candidate, options.structuredOutputSchema);
    } catch (error) {
      throw new BrainProviderError(
        `DashScopeQwenProvider output failed local schema validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private assertMatchesInput(input: BrainInput, output: BrainOutput): void {
    if (output.requestId !== input.requestId) {
      throw new BrainProviderError(
        `DashScopeQwenProvider output requestId ${output.requestId} does not match input ${input.requestId}`,
      );
    }

    if (output.taskType !== input.taskType) {
      throw new BrainProviderError(
        `DashScopeQwenProvider output taskType ${output.taskType} does not match input ${input.taskType}`,
      );
    }

    if (output.provider !== this.providerName) {
      throw new BrainProviderError(
        `DashScopeQwenProvider output provider must be ${this.providerName}, got ${output.provider}`,
      );
    }
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BrainProviderError("DashScopeQwenProvider now() returned an invalid Date");
    }

    return value.toISOString();
  }

  private errorForStatus(status: number, statusText: string | undefined, text: string): BrainProviderError {
    const detail = extractProviderErrorMessage(text);
    const statusLabel = `${status} ${statusText ?? ""}`.trim();

    if (status === 401 || status === 403) {
      return new BrainProviderError(
        `DashScopeQwenProvider auth_failed: ${statusLabel}${detail}`,
      );
    }

    if (status === 429) {
      return new BrainProviderError(
        `DashScopeQwenProvider rate_limited: ${statusLabel}${detail}`,
      );
    }

    if (status >= 500) {
      return new BrainProviderError(
        `DashScopeQwenProvider server_error: ${statusLabel}${detail}`,
      );
    }

    return new BrainProviderError(
      `DashScopeQwenProvider request failed: ${statusLabel}${detail}`,
    );
  }
}

function parseHttpJson(text: string): DashScopeChatCompletionResponse {
  try {
    return JSON.parse(text) as DashScopeChatCompletionResponse;
  } catch (error) {
    throw new BrainProviderError("DashScopeQwenProvider HTTP response was not valid JSON", {
      cause: error,
    });
  }
}

function extractDashScopeMessageContent(response: DashScopeChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new BrainProviderError(
      "DashScopeQwenProvider response did not contain message content",
    );
  }

  return content;
}

function parseDashScopeContentJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new BrainProviderError("DashScopeQwenProvider message content was not valid JSON", {
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
