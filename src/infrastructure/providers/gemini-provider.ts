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

export interface GeminiProviderOptions {
  apiKey?: string;
  /** Base URL up to (and including) the API version, e.g. `.../v1beta`. */
  apiBaseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: GeminiFetchLike;
  now?: () => Date;
  temperature?: number;
  maxTokens?: number;
}

export interface GeminiFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface GeminiFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type GeminiFetchLike = (
  input: string,
  init?: GeminiFetchInit,
) => Promise<GeminiFetchResponse>;

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Native Gemini generateContent REST adapter.
 *
 * Uses raw fetch (no Google SDK) to stay consistent with the other providers
 * and fully testable with a mock fetch. Follows the GeminiProvider ADR: requests
 * a compact JSON object via responseMimeType=application/json, never enables any
 * Gemini built-in tools, and re-validates the candidate locally before returning.
 */
export class GeminiProvider implements BrainProvider {
  readonly providerName = "gemini" as const;
  private readonly apiKey: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: GeminiFetchLike;
  private readonly now: () => Date;
  private readonly temperature: number;
  private readonly maxTokens: number | undefined;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const parsedInput = brainInputSchema.parse(input);
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const response = await this.fetchGenerateContent(apiKey, parsedInput);
    const content = extractGeminiText(response);
    const rawContent = parseGeminiContentJson(content);
    const candidate = this.toBrainOutputCandidate(rawContent, parsedInput);
    const output = this.validateCandidate(candidate, options);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  private endpoint(): string {
    return `${this.apiBaseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
  }

  private async fetchGenerateContent(
    apiKey: string,
    input: BrainInput,
  ): Promise<GeminiGenerateContentResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint(), {
        method: "POST",
        headers: {
          // Pass the key as a header (not a query param) so it never lands in URLs/logs.
          "x-goog-api-key": apiKey,
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
        throw new BrainProviderError("GeminiProvider returned an empty HTTP response");
      }

      const parsed = parseHttpJson(text);

      if (parsed.error) {
        throw new BrainProviderError(
          `GeminiProvider returned provider error ${parsed.error.status ?? parsed.error.code ?? "unknown"}: ${
            parsed.error.message ?? "no message"
          }`,
        );
      }

      if (parsed.promptFeedback?.blockReason) {
        throw new BrainProviderError(
          `GeminiProvider blocked the prompt: ${parsed.promptFeedback.blockReason}`,
        );
      }

      return parsed;
    } catch (error) {
      if (error instanceof BrainProviderError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new BrainProviderError(
          `GeminiProvider request timed out after ${this.timeoutMs}ms`,
          { cause: error },
        );
      }

      throw new BrainProviderError(`GeminiProvider request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(input: BrainInput): Record<string, unknown> {
    return {
      systemInstruction: {
        parts: [
          {
            text: [
              "You are Secretary's Gemini brain provider adapter.",
              "Return one valid JSON object matching the BrainOutput contract.",
              "Do not execute tools, do not place orders, do not write accounts, and do not overwrite rules.",
              "Any trade or memory write idea must remain a review-required proposal.",
            ].join(" "),
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
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
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: this.temperature,
        ...(this.maxTokens === undefined ? {} : { maxOutputTokens: this.maxTokens }),
      },
    };
  }

  private toBrainOutputCandidate(rawContent: unknown, input: BrainInput): unknown {
    if (typeof rawContent !== "object" || rawContent === null || Array.isArray(rawContent)) {
      throw new BrainProviderError("GeminiProvider message content must be a JSON object");
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
        `GeminiProvider output failed local schema validation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  private assertMatchesInput(input: BrainInput, output: BrainOutput): void {
    if (output.requestId !== input.requestId) {
      throw new BrainProviderError(
        `GeminiProvider output requestId ${output.requestId} does not match input ${input.requestId}`,
      );
    }

    if (output.taskType !== input.taskType) {
      throw new BrainProviderError(
        `GeminiProvider output taskType ${output.taskType} does not match input ${input.taskType}`,
      );
    }

    if (output.provider !== this.providerName) {
      throw new BrainProviderError(
        `GeminiProvider output provider must be ${this.providerName}, got ${output.provider}`,
      );
    }
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BrainProviderError("GeminiProvider now() returned an invalid Date");
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

    if (status === 400 && /api[_ ]?key/i.test(text)) {
      return new BrainProviderError(`GeminiProvider auth_failed: ${statusLabel}${detail}`);
    }

    if (status === 401 || status === 403) {
      return new BrainProviderError(`GeminiProvider auth_failed: ${statusLabel}${detail}`);
    }

    if (status === 429) {
      return new BrainProviderError(`GeminiProvider rate_limited: ${statusLabel}${detail}`);
    }

    if (status >= 500) {
      return new BrainProviderError(`GeminiProvider server_error: ${statusLabel}${detail}`);
    }

    return new BrainProviderError(`GeminiProvider request failed: ${statusLabel}${detail}`);
  }
}

function parseHttpJson(text: string): GeminiGenerateContentResponse {
  try {
    return JSON.parse(text) as GeminiGenerateContentResponse;
  } catch (error) {
    throw new BrainProviderError("GeminiProvider HTTP response was not valid JSON", {
      cause: error,
    });
  }
}

function extractGeminiText(response: GeminiGenerateContentResponse): string {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts;

  if (!Array.isArray(parts) || parts.length === 0) {
    const finishReason = candidate?.finishReason;
    throw new BrainProviderError(
      `GeminiProvider response did not contain content${
        finishReason ? ` (finishReason: ${finishReason})` : ""
      }`,
    );
  }

  const text = parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();

  if (text === "") {
    throw new BrainProviderError("GeminiProvider response content text was empty");
  }

  return text;
}

function parseGeminiContentJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new BrainProviderError("GeminiProvider message content was not valid JSON", {
      cause: error,
    });
  }
}

function extractProviderErrorMessage(text: string): string {
  if (text.trim() === "") {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
    const message = parsed.error?.message ?? parsed.error?.status;
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
