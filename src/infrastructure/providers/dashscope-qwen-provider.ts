import {
  brainInputSchema,
  validateBrainOutput,
  type AgentMessage,
  type AgentToolCall,
  type AgentToolSpec,
  type AgentToolStep,
  type BrainGenerateOptions,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
  type ChatWithToolsRequest,
  type ToolCallingProvider,
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
  /** Bounded retries for transient (429/5xx/empty) failures. Default 2. */
  maxRetries?: number;
  /** Base backoff between retries (doubled each attempt). Default 500ms; 0 in tests. */
  retryBaseDelayMs?: number;
  /** Enable the SSE streaming path (generateStream). Default true. */
  streaming?: boolean;
  /** Idle (keepalive) timeout for the streaming path: abort if no chunk for this long. Default 30s. */
  idleTimeoutMs?: number;
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
  /** Raw SSE byte stream for the streaming path; absent on mocks → non-streaming fallback. */
  body?: ReadableStream<Uint8Array> | null;
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
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export class DashScopeQwenProvider implements BrainProvider, ToolCallingProvider {
  readonly providerName = "dashscope" as const;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: DashScopeFetchLike;
  private readonly now: () => Date;
  private readonly temperature: number;
  private readonly maxTokens: number | undefined;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly streaming: boolean;
  private readonly idleTimeoutMs: number;

  constructor(options: DashScopeQwenProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_DASHSCOPE_ENDPOINT;
    this.model = options.model ?? DEFAULT_DASHSCOPE_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.streaming = options.streaming ?? true;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const parsedInput = brainInputSchema.parse(input);
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const response = await this.fetchWithRetry(apiKey, parsedInput);
    assertNotTruncated(response);
    const content = extractDashScopeMessageContent(response);
    const rawContent = parseDashScopeContentJson(content);
    const candidate = this.toBrainOutputCandidate(rawContent, parsedInput);
    const output = this.validateCandidate(candidate, options);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  /**
   * Streaming variant: streams the SSE response and bounds liveness by an IDLE timeout
   * (reset on every chunk) instead of one total timeout, so a long-but-live answer
   * completes. Accumulates the JSON content, then validates it exactly like generate().
   * Falls back to the non-streaming behaviour when streaming is disabled or the fetch
   * impl can't expose a byte stream (e.g. a test mock).
   */
  async generateStream(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    if (!this.streaming) {
      return this.generate(input, options);
    }

    const parsedInput = brainInputSchema.parse(input);
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const { content, finishReason } = await this.fetchStreamWithRetry(apiKey, parsedInput, options);
    assertNotTruncatedReason(finishReason);
    const rawContent = parseDashScopeContentJson(content);
    const candidate = this.toBrainOutputCandidate(rawContent, parsedInput);
    const output = this.validateCandidate(candidate, options);

    this.assertMatchesInput(parsedInput, output);
    return output;
  }

  /**
   * OpenAI-style function calling for the agentic tool loop. One round-trip: sends the
   * running transcript + tool specs, and returns the assistant text plus any tool calls
   * the model requested. Streamed (SSE) and bounded by the same IDLE timeout as
   * generateStream, accumulating both content and tool_call argument deltas. Falls back
   * to a non-streaming parse when the fetch impl can't expose a byte stream (mocks).
   *
   * It does NOT validate a BrainOutput contract — the loop drives free-form reasoning
   * plus tool calls; the deterministic "hand" behind each write tool enforces the rules.
   */
  async chatWithTools(request: ChatWithToolsRequest): Promise<AgentToolStep> {
    const apiKey = requireBrainProviderApiKey(this.providerName, this.apiKey);
    const body = this.buildToolRequestBody(request, this.streaming);

    if (!this.streaming) {
      return this.fetchToolCompletionNonStreaming(apiKey, body);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.fetchToolCompletionStream(apiKey, body, request);
      } catch (error) {
        lastError = error;
        if (error instanceof BrainProviderError && error.retryable && attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BrainProviderError("DashScopeQwenProvider tool stream retry exhausted");
  }

  private async fetchToolCompletionNonStreaming(
    apiKey: string,
    body: Record<string, unknown>,
  ): Promise<AgentToolStep> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, stream: false }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, text);
      }
      return parseToolCompletionJson(text);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchToolCompletionStream(
    apiKey: string,
    body: Record<string, unknown>,
    request: ChatWithToolsRequest,
  ): Promise<AgentToolStep> {
    const idleTimeoutMs = request.idleTimeoutMs ?? this.idleTimeoutMs;
    const controller = new AbortController();
    const startedAt = this.now().getTime();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;

    const armIdle = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    const onExternalAbort = (): void => controller.abort();

    if (request.signal !== undefined) {
      if (request.signal.aborted) {
        controller.abort();
      } else {
        request.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    armIdle();

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, await safeText(response));
      }

      const stream = response.body;
      if (stream === undefined || stream === null || typeof stream.getReader !== "function") {
        return parseToolCompletionJson(await response.text());
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const accumulator = new ToolCallAccumulator();
      let buffer = "";
      let content = "";
      let finishReason: string | undefined;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        armIdle();
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          const event = parseSseToolDeltaLine(line);
          if (event !== undefined && !event.done) {
            content += event.content;
            accumulator.apply(event.toolCalls);
            if (event.finishReason !== undefined) {
              finishReason = event.finishReason;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }

        if (content.length > 0) {
          request.onProgress?.({ chars: content.length, elapsedMs: this.now().getTime() - startedAt });
        }
      }

      return { content, toolCalls: accumulator.toToolCalls(), finishReason };
    } catch (error) {
      if (error instanceof BrainProviderError) {
        throw error;
      }
      if (idleTimedOut) {
        throw new BrainProviderError(
          `DashScopeQwenProvider tool stream idle-timed out after ${idleTimeoutMs}ms (no output)`,
          { retryable: true, cause: error },
        );
      }
      if (request.signal?.aborted) {
        throw new BrainProviderError("DashScopeQwenProvider tool stream was cancelled", { cause: error });
      }
      if (isAbortError(error)) {
        throw new BrainProviderError("DashScopeQwenProvider tool stream aborted", { cause: error });
      }
      throw new BrainProviderError(`DashScopeQwenProvider tool stream request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private buildToolRequestBody(
    request: ChatWithToolsRequest,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages: request.messages.map(toOpenAiMessage),
      tools: request.tools.map(toOpenAiTool),
      tool_choice: request.toolChoice ?? "auto",
      stream,
      temperature: this.temperature,
      ...(this.maxTokens === undefined ? {} : { max_tokens: this.maxTokens }),
    };
  }

  private async fetchStreamWithRetry(
    apiKey: string,
    input: BrainInput,
    options: BrainGenerateOptions,
  ): Promise<{ content: string; finishReason?: string }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.fetchCompletionStream(apiKey, input, options);
      } catch (error) {
        lastError = error;

        if (error instanceof BrainProviderError && error.retryable && attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BrainProviderError("DashScopeQwenProvider stream retry exhausted");
  }

  private async fetchCompletionStream(
    apiKey: string,
    input: BrainInput,
    options: BrainGenerateOptions,
  ): Promise<{ content: string; finishReason?: string }> {
    const idleTimeoutMs = options.idleTimeoutMs ?? this.idleTimeoutMs;
    const controller = new AbortController();
    const startedAt = this.now().getTime();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimedOut = false;

    const armIdle = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    const onExternalAbort = (): void => controller.abort();

    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    armIdle();

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(this.buildRequestBody(input, true)),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, await safeText(response));
      }

      const body = response.body;
      if (body === undefined || body === null || typeof body.getReader !== "function") {
        // No byte stream (e.g. a mock) — read it all and parse as SSE blob or plain JSON.
        return parseNonStreamingFallback(await response.text());
      }

      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let finishReason: string | undefined;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        armIdle();
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          const event = parseSseDataLine(line);
          if (event !== undefined && !event.done) {
            content += event.content;
            if (event.finishReason !== undefined) {
              finishReason = event.finishReason;
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }

        if (content.length > 0) {
          options.onProgress?.({ chars: content.length, elapsedMs: this.now().getTime() - startedAt });
        }
      }

      return { content, finishReason };
    } catch (error) {
      if (error instanceof BrainProviderError) {
        throw error;
      }

      if (idleTimedOut) {
        throw new BrainProviderError(
          `DashScopeQwenProvider stream idle-timed out after ${idleTimeoutMs}ms (no output)`,
          { retryable: true, cause: error },
        );
      }

      if (options.signal?.aborted) {
        throw new BrainProviderError("DashScopeQwenProvider stream was cancelled", { cause: error });
      }

      if (isAbortError(error)) {
        throw new BrainProviderError("DashScopeQwenProvider stream aborted", { cause: error });
      }

      throw new BrainProviderError(`DashScopeQwenProvider stream request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      options.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private async fetchWithRetry(
    apiKey: string,
    input: BrainInput,
  ): Promise<DashScopeChatCompletionResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.fetchCompletion(apiKey, input);
      } catch (error) {
        lastError = error;

        if (error instanceof BrainProviderError && error.retryable && attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BrainProviderError("DashScopeQwenProvider retry exhausted");
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
        body: JSON.stringify(this.buildRequestBody(input, false)),
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        throw this.errorForStatus(response.status, response.statusText, text);
      }

      if (text.trim() === "") {
        throw new BrainProviderError("DashScopeQwenProvider returned an empty HTTP response", {
          retryable: true,
        });
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

  private buildRequestBody(input: BrainInput, stream: boolean): Record<string, unknown> {
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
      stream,
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
        { retryable: true },
      );
    }

    if (status >= 500) {
      return new BrainProviderError(
        `DashScopeQwenProvider server_error: ${statusLabel}${detail}`,
        { retryable: true },
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

/**
 * Whether an in-stream error chunk is a TRANSIENT server-side blip worth retrying
 * (5xx / internal_server_error / service unavailable / "batching backend" / timeout /
 * overload / throttling) vs a permanent one (invalid_request, auth, content policy).
 * The model serving 500 we saw ("InternalError.Algo: Receive batching backend response
 * failed") is transient — a fresh request usually succeeds.
 */
function isTransientStreamError(code: string | undefined, message: string | undefined): boolean {
  const haystack = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  return /(internal_server_error|internalerror|service.?unavailable|request.?timeout|batching backend|try again|timed? ?out|timeout|temporar|overload|throttl|rate.?limit|\b5\d\d\b|<5\d\d>)/.test(
    haystack,
  );
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

/**
 * A `finish_reason: "length"` means the model hit the token cap mid-output, so the
 * JSON is truncated. Surface that as a clear, actionable error instead of a
 * misleading "invalid JSON" further down. Not retryable — retrying won't shrink it.
 */
function assertNotTruncated(response: DashScopeChatCompletionResponse): void {
  assertNotTruncatedReason(response.choices?.[0]?.finish_reason);
}

function assertNotTruncatedReason(finishReason: string | undefined): void {
  if (finishReason === "length") {
    throw new BrainProviderError(
      "DashScopeQwenProvider 输出过长被截断（finish_reason=length）。请把请求拆小一点，或调大 BRAIN_MAX_TOKENS。",
    );
  }
}

interface SseContentEvent {
  content: string;
  finishReason?: string;
  done?: boolean;
}

/**
 * Parses one SSE line from the OpenAI-compatible stream. Returns undefined for
 * non-data lines (comments / blanks / keepalives), `{ done: true }` for the terminal
 * `[DONE]`, and the content delta + finish_reason otherwise. Throws on an error chunk.
 */
function parseSseDataLine(line: string): SseContentEvent | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const data = line.slice(5).trim();
  if (data === "") {
    return undefined;
  }
  if (data === "[DONE]") {
    return { content: "", done: true };
  }

  let chunk: {
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
    error?: { code?: string; message?: string; type?: string };
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    return undefined; // ignore an unparseable keepalive fragment
  }

  if (chunk.error) {
    throw new BrainProviderError(
      `DashScopeQwenProvider stream error ${chunk.error.code ?? "unknown"}: ${
        chunk.error.message ?? chunk.error.type ?? "no message"
      }`,
      // A mid-stream 5xx / internal_server_error / "batching backend" blip is transient —
      // mark it retryable so fetchStreamWithRetry re-runs the request instead of dropping
      // the node (the "重演失败，跳过" case).
      { retryable: isTransientStreamError(chunk.error.code, chunk.error.message) },
    );
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta?.content;
  return {
    content: typeof delta === "string" ? delta : "",
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

/**
 * Fallback when the response has no byte stream (e.g. a test mock returning text()):
 * parse an SSE blob if present, else a plain chat-completion JSON body.
 */
function parseNonStreamingFallback(text: string): { content: string; finishReason?: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new BrainProviderError("DashScopeQwenProvider returned an empty stream response", {
      retryable: true,
    });
  }

  if (/^data:/m.test(trimmed)) {
    let content = "";
    let finishReason: string | undefined;
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const event = parseSseDataLine(rawLine.trim());
      if (event !== undefined && !event.done) {
        content += event.content;
        if (event.finishReason !== undefined) {
          finishReason = event.finishReason;
        }
      }
    }
    return { content, finishReason };
  }

  const parsed = parseHttpJson(trimmed);
  if (parsed.error) {
    throw new BrainProviderError(
      `DashScopeQwenProvider returned provider error ${parsed.error.code ?? "unknown"}: ${
        parsed.error.message ?? parsed.error.type ?? "no message"
      }`,
    );
  }
  return {
    content: extractDashScopeMessageContent(parsed),
    finishReason: parsed.choices?.[0]?.finish_reason,
  };
}

async function safeText(response: DashScopeFetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Maps a loop transcript message onto an OpenAI-compatible chat message. */
function toOpenAiMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAiTool(spec: AgentToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  };
}

interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

/** Reassembles streamed OpenAI tool_call deltas (one slice per chunk) into whole calls. */
class ToolCallAccumulator {
  private readonly byIndex = new Map<number, { id: string; name: string; arguments: string }>();
  private readonly order: number[] = [];

  apply(deltas: ToolCallDelta[]): void {
    for (const delta of deltas) {
      let entry = this.byIndex.get(delta.index);
      if (entry === undefined) {
        entry = { id: "", name: "", arguments: "" };
        this.byIndex.set(delta.index, entry);
        this.order.push(delta.index);
      }
      if (delta.id) {
        entry.id = delta.id;
      }
      if (delta.name) {
        entry.name = delta.name;
      }
      if (delta.argumentsDelta) {
        entry.arguments += delta.argumentsDelta;
      }
    }
  }

  toToolCalls(): AgentToolCall[] {
    return this.order
      .map((index) => {
        const entry = this.byIndex.get(index)!;
        return {
          id: entry.id || `call_${index}`,
          name: entry.name,
          arguments: entry.arguments || "{}",
        };
      })
      .filter((call) => call.name !== "");
  }
}

interface SseToolDeltaEvent {
  content: string;
  toolCalls: ToolCallDelta[];
  finishReason?: string;
  done?: boolean;
}

/** Parses one SSE line from the tool-calling stream into content + tool_call deltas. */
function parseSseToolDeltaLine(line: string): SseToolDeltaEvent | undefined {
  if (!line.startsWith("data:")) {
    return undefined;
  }
  const data = line.slice(5).trim();
  if (data === "") {
    return undefined;
  }
  if (data === "[DONE]") {
    return { content: "", toolCalls: [], done: true };
  }

  let chunk: {
    choices?: Array<{
      delta?: {
        content?: unknown;
        tool_calls?: Array<{
          index?: unknown;
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>;
      };
      finish_reason?: unknown;
    }>;
    error?: { code?: string; message?: string; type?: string };
  };
  try {
    chunk = JSON.parse(data);
  } catch {
    return undefined;
  }

  if (chunk.error) {
    throw new BrainProviderError(
      `DashScopeQwenProvider tool stream error ${chunk.error.code ?? "unknown"}: ${
        chunk.error.message ?? chunk.error.type ?? "no message"
      }`,
      { retryable: isTransientStreamError(chunk.error.code, chunk.error.message) },
    );
  }

  const choice = chunk.choices?.[0];
  const deltaContent = choice?.delta?.content;
  const toolCalls: ToolCallDelta[] = [];
  for (const raw of choice?.delta?.tool_calls ?? []) {
    toolCalls.push({
      index: typeof raw.index === "number" ? raw.index : 0,
      id: typeof raw.id === "string" ? raw.id : undefined,
      name: typeof raw.function?.name === "string" ? raw.function.name : undefined,
      argumentsDelta: typeof raw.function?.arguments === "string" ? raw.function.arguments : undefined,
    });
  }
  return {
    content: typeof deltaContent === "string" ? deltaContent : "",
    toolCalls,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
  };
}

/** Parses a non-streaming (or SSE-blob) tool-calling response into an AgentToolStep. */
function parseToolCompletionJson(text: string): AgentToolStep {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new BrainProviderError("DashScopeQwenProvider returned an empty tool response", {
      retryable: true,
    });
  }

  if (/^data:/m.test(trimmed)) {
    const accumulator = new ToolCallAccumulator();
    let content = "";
    let finishReason: string | undefined;
    for (const rawLine of trimmed.split(/\r?\n/)) {
      const event = parseSseToolDeltaLine(rawLine.trim());
      if (event !== undefined && !event.done) {
        content += event.content;
        accumulator.apply(event.toolCalls);
        if (event.finishReason !== undefined) {
          finishReason = event.finishReason;
        }
      }
    }
    return { content, toolCalls: accumulator.toToolCalls(), finishReason };
  }

  const parsed = parseHttpJson(trimmed) as DashScopeChatCompletionResponse & {
    choices?: Array<{
      message?: {
        content?: unknown;
        tool_calls?: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
      };
      finish_reason?: string;
    }>;
  };
  if (parsed.error) {
    throw new BrainProviderError(
      `DashScopeQwenProvider returned provider error ${parsed.error.code ?? "unknown"}: ${
        parsed.error.message ?? parsed.error.type ?? "no message"
      }`,
    );
  }
  const message = parsed.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls: AgentToolCall[] = [];
  for (const raw of message?.tool_calls ?? []) {
    const name = typeof raw.function?.name === "string" ? raw.function.name : "";
    if (name === "") {
      continue;
    }
    toolCalls.push({
      id: typeof raw.id === "string" ? raw.id : `call_${toolCalls.length}`,
      name,
      arguments: typeof raw.function?.arguments === "string" ? raw.function.arguments : "{}",
    });
  }
  return { content, toolCalls, finishReason: parsed.choices?.[0]?.finish_reason };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
