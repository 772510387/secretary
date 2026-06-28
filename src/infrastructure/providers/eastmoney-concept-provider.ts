import { type UniverseStock } from "../../domain/market/index.js";
import { ProviderError } from "./errors.js";
import {
  parseUniversePage,
  type UniverseFetchLike,
  type UniverseFetchResponse,
} from "./eastmoney-universe-provider.js";

export class ConceptProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConceptProviderError";
  }
}

/** One 概念/题材 board (BKxxxx) and its day heat. */
export interface ConceptBoard {
  /** Board code, e.g. "BK1128" (CPO概念). */
  boardCode: string;
  name: string;
  /** Board 涨跌幅 (%). */
  changePct?: number;
  /** Board 主力净流入 (yuan). */
  netInflow?: number;
}

export interface EastmoneyConceptProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: UniverseFetchLike;
}

const DEFAULT_ENDPOINT = "https://push2his.eastmoney.com/api/qt/clist/get";
// fs=m:90+t:3 → 概念/题材 boards (NOT t:2 一级行业); fs=b:<BKcode> → that board's member stocks.
const CONCEPT_LIST_FS = "m:90+t:3";
const CONCEPT_LIST_FIELDS = "f12,f14,f3,f62";
const MEMBER_FIELDS = "f12,f13,f14,f2,f3,f5,f6,f8,f20";

/**
 * Fetches A-share 概念/题材板块 成分 from Eastmoney — the 概念→个股 membership the audit said
 * had "no source" (f100 is only 一级行业). `getHotConcepts` ranks today's hottest themes in ONE
 * request (sorted by board 涨幅); `getConceptMembers` returns a board's stocks (reusing the
 * universe row parser). Network-gated, read-only, no LLM. Deterministic real membership — so a
 * "题材自动筛池" never lets the model invent which stocks belong to a theme.
 */
export class EastmoneyConceptProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: UniverseFetchLike;

  constructor(options: EastmoneyConceptProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /** Today's hottest 概念 boards, by board 涨幅 descending. One request. */
  async getHotConcepts(options: { topK?: number; minChangePct?: number } = {}): Promise<ConceptBoard[]> {
    const topK = options.topK ?? 8;
    const minChangePct = options.minChangePct ?? 0;
    const url =
      `${this.endpoint}?pn=1&pz=100&po=1&np=1&fltt=2&invt=2` +
      `&fid=f3&fs=${CONCEPT_LIST_FS}&fields=${CONCEPT_LIST_FIELDS}`;
    const boards = parseConceptList(await this.fetchTextWithRetry(url));
    return boards
      .filter((board) => board.changePct === undefined || board.changePct >= minChangePct)
      .slice(0, topK);
  }

  /** A concept board's member stocks (reuses the universe-row parser; main-board filtered downstream). */
  async getConceptMembers(boardCode: string): Promise<UniverseStock[]> {
    if (!/^BK\d+$/.test(boardCode)) {
      return [];
    }
    const url =
      `${this.endpoint}?pn=1&pz=200&po=1&np=1&fltt=2&invt=2` +
      `&fid=f3&fs=b:${boardCode}&fields=${MEMBER_FIELDS}`;
    return parseUniversePage(await this.fetchTextWithRetry(url)).rows;
  }

  private async fetchTextWithRetry(url: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.fetchText(url);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await sleep(this.retryBaseDelayMs * (attempt + 1));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ConceptProviderError("Eastmoney concept request failed after retries");
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://quote.eastmoney.com/" },
      });
      if (!response.ok) {
        throw new ConceptProviderError(
          `Eastmoney concept request failed: ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }
      const text = await response.text();
      if (text.trim() === "") {
        throw new ConceptProviderError("Eastmoney concept response was empty");
      }
      return text;
    } catch (error) {
      if (error instanceof ConceptProviderError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new ConceptProviderError(`Eastmoney concept request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new ConceptProviderError(`Eastmoney concept request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface ConceptRow {
  f12?: unknown; // board code BKxxxx
  f14?: unknown; // concept name
  f3?: unknown; // board change %
  f62?: unknown; // board 主力净流入
}

/** Parses the concept-board list payload into ConceptBoard[] (rows whose code is a BK board). */
export function parseConceptList(text: string): ConceptBoard[] {
  let parsed: { data?: { diff?: ConceptRow[] | Record<string, ConceptRow> } | null };
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConceptProviderError("Eastmoney concept response was not valid JSON", { cause: error });
  }
  const diff = parsed.data?.diff;
  if (diff === undefined || diff === null) {
    return [];
  }
  const rows = Array.isArray(diff) ? diff : Object.values(diff);
  const out: ConceptBoard[] = [];
  for (const row of rows) {
    const boardCode = typeof row.f12 === "string" ? row.f12 : String(row.f12 ?? "");
    const name = typeof row.f14 === "string" ? row.f14.trim() : "";
    if (!/^BK\d+$/.test(boardCode) || !name) {
      continue;
    }
    out.push({
      boardCode,
      name,
      changePct: numberOrUndefined(row.f3),
      netInflow: numberOrUndefined(row.f62),
    });
  }
  return out;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "" && value !== "-") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultFetch: UniverseFetchLike = async (url, init): Promise<UniverseFetchResponse> => {
  const response = await globalThis.fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  };
};
