import { SearchProviderError } from "./errors.js";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchResult {
  query: string;
  answer?: string;
  results: WebSearchResultItem[];
}

export interface TavilySearchOptions {
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
  includeAnswer?: boolean;
  topic?: "general" | "news";
}

export interface TavilySearchProviderOptions {
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: TavilyFetchLike;
}

export interface TavilyFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface TavilyFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type TavilyFetchLike = (
  input: string,
  init?: TavilyFetchInit,
) => Promise<TavilyFetchResponse>;

interface TavilyApiResponse {
  query?: string;
  answer?: unknown;
  results?: Array<{
    title?: unknown;
    url?: unknown;
    content?: unknown;
    score?: unknown;
  }>;
  error?: unknown;
}

const DEFAULT_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;

/**
 * Tavily web search adapter. Raw fetch, no SDK, fully mockable.
 *
 * This is a backend-executed, read-only capability: the search runs on the
 * backend and its results are fed to the model as context. The model never gets
 * an autonomous web tool, never executes anything, and cannot place orders or
 * write accounts — that safety boundary is unchanged.
 */
export class TavilySearchProvider {
  readonly providerName = "tavily" as const;
  private readonly apiKey: string | undefined;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: TavilyFetchLike;

  constructor(options: TavilySearchProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TAVILY_API_KEY;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async search(query: string, options: TavilySearchOptions = {}): Promise<WebSearchResult> {
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
      throw new SearchProviderError("TavilySearchProvider query must not be empty");
    }

    const apiKey = this.apiKey?.trim();

    if (!apiKey) {
      throw new SearchProviderError(
        "TavilySearchProvider requires an API key; set TAVILY_API_KEY or configure search.tavilyApiKey.",
      );
    }

    const body = JSON.stringify({
      query: trimmedQuery,
      max_results: options.maxResults ?? DEFAULT_MAX_RESULTS,
      search_depth: options.searchDepth ?? "basic",
      include_answer: options.includeAnswer ?? true,
      topic: options.topic ?? "general",
    });
    const response = await this.fetchWithTimeout(apiKey, body);
    const text = await response.text();

    if (!response.ok) {
      throw this.errorForStatus(response.status, response.statusText, text);
    }

    if (text.trim() === "") {
      throw new SearchProviderError("TavilySearchProvider returned an empty HTTP response");
    }

    return this.parseResponse(trimmedQuery, text);
  }

  private async fetchWithTimeout(apiKey: string, body: string): Promise<TavilyFetchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new SearchProviderError(
          `TavilySearchProvider request timed out after ${this.timeoutMs}ms`,
          { cause: error },
        );
      }

      throw new SearchProviderError(`TavilySearchProvider request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseResponse(query: string, text: string): WebSearchResult {
    let parsed: TavilyApiResponse;

    try {
      parsed = JSON.parse(text) as TavilyApiResponse;
    } catch (error) {
      throw new SearchProviderError("TavilySearchProvider response was not valid JSON", {
        cause: error,
      });
    }

    const results: WebSearchResultItem[] = (parsed.results ?? [])
      .map((item) => ({
        title: typeof item.title === "string" ? item.title.trim() : "",
        url: typeof item.url === "string" ? item.url.trim() : "",
        snippet: typeof item.content === "string" ? item.content.trim().slice(0, 2000) : "",
        score: typeof item.score === "number" ? item.score : undefined,
      }))
      .filter((item) => item.url !== "" && (item.title !== "" || item.snippet !== ""));

    return {
      query,
      answer: typeof parsed.answer === "string" && parsed.answer.trim() !== "" ? parsed.answer.trim() : undefined,
      results,
    };
  }

  private errorForStatus(
    status: number,
    statusText: string | undefined,
    text: string,
  ): SearchProviderError {
    const detail = extractErrorMessage(text);
    const label = `${status} ${statusText ?? ""}`.trim();

    if (status === 401 || status === 403) {
      return new SearchProviderError(`TavilySearchProvider auth_failed: ${label}${detail}`);
    }

    if (status === 429) {
      return new SearchProviderError(`TavilySearchProvider rate_limited: ${label}${detail}`);
    }

    if (status >= 500) {
      return new SearchProviderError(`TavilySearchProvider server_error: ${label}${detail}`);
    }

    return new SearchProviderError(`TavilySearchProvider request failed: ${label}${detail}`);
  }
}

function defaultFetch(input: string, init?: TavilyFetchInit): Promise<TavilyFetchResponse> {
  return globalThis.fetch(input, init) as Promise<TavilyFetchResponse>;
}

function extractErrorMessage(text: string): string {
  if (text.trim() === "") {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.detail === "string"
          ? parsed.detail
          : undefined;
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
