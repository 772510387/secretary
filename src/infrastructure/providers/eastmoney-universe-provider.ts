import {
  universeStockSchema,
  type ScreenSortField,
  type UniverseQuery,
  type UniverseStock,
} from "../../domain/market/index.js";
import { ProviderError } from "./errors.js";

export class UniverseProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "UniverseProviderError";
  }
}

export interface UniverseFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export interface UniverseFetchInit {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type UniverseFetchLike = (
  url: string,
  init?: UniverseFetchInit,
) => Promise<UniverseFetchResponse>;

export interface EastmoneyUniverseProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  /** Eastmoney clist hard-caps at 100 rows/page, so this defaults to 100. */
  pageSize?: number;
  /** Pages fetched in parallel (the full A-share list is ~56 pages). */
  concurrency?: number;
  /** Safety bound on total pages fetched. */
  maxPages?: number;
  /** Per-page retries on transient network failures (Eastmoney drops sockets under bursts). */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  /** Delay between page batches to avoid rate limiting. */
  interBatchDelayMs?: number;
  /** Over-fetch factor vs targetCount, to survive local filtering (ST/halted/thresholds). */
  marginFactor?: number;
  fetchImpl?: UniverseFetchLike;
}

export interface UniverseProvider {
  getUniverse(query?: UniverseQuery): Promise<UniverseStock[]>;
}

const DEFAULT_ENDPOINT = "https://push2.eastmoney.com/api/qt/clist/get";
// Full 沪深 A-share board set (SZSE main + ChiNext + SSE main + STAR).
const BROAD_BOARD_FILTER = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23";
// Main boards only — half the rows, and the screener's default anyway.
const MAINBOARD_BOARD_FILTER = "m:0+t:6,m:1+t:2";
// f100 = 所属行业 (sector); f62 = 主力净流入额; f184 = 主力净流入占比. Best-effort: some
// rows/sources omit them → mapped to undefined (graceful, never fabricated).
const FIELDS = "f12,f13,f14,f2,f3,f5,f6,f8,f20,f100,f62,f184";

// Eastmoney sort field id per screener sort field — lets the API sort server-side
// so we can fetch just the top pages instead of the whole market.
const FID_BY_SORT: Record<ScreenSortField, string> = {
  amount: "f6",
  changePct: "f3",
  turnoverRate: "f8",
  marketCap: "f20",
  latestPrice: "f2",
};

interface PageParams {
  fid: string;
  po: number;
  fs: string;
}

interface EastmoneyRow {
  f12?: unknown; // code
  f13?: unknown; // market: 0 SZSE, 1 SSE
  f14?: unknown; // name
  f2?: unknown; // latest price
  f3?: unknown; // change %
  f5?: unknown; // volume (手)
  f6?: unknown; // amount (yuan)
  f8?: unknown; // turnover rate %
  f20?: unknown; // total market cap (yuan)
  f100?: unknown; // 所属行业 (sector)
  f62?: unknown; // 主力净流入额 (yuan)
  f184?: unknown; // 主力净流入占比 (%)
}

interface EastmoneyResponse {
  data?: {
    total?: number;
    diff?: EastmoneyRow[] | Record<string, EastmoneyRow>;
  } | null;
}

/**
 * Fetches the full A-share spot universe from Eastmoney (push2 clist), the real
 * market-wide list a screener ranks over. `fltt=2` returns proper floats (price
 * 12.34, not 1234), avoiding scaling guesswork. One request, ~5000 rows.
 *
 * Network-gated and best-effort per row (a malformed row is skipped, not fatal).
 * No LLM, no broker, read-only.
 */
export class EastmoneyUniverseProvider implements UniverseProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly concurrency: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly interBatchDelayMs: number;
  private readonly marginFactor: number;
  private readonly fetchImpl: UniverseFetchLike;

  constructor(options: EastmoneyUniverseProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pageSize = options.pageSize ?? 100;
    this.concurrency = options.concurrency ?? 3;
    this.maxPages = options.maxPages ?? 80;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 600;
    this.interBatchDelayMs = options.interBatchDelayMs ?? 120;
    this.marginFactor = options.marginFactor ?? 3;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async getUniverse(query: UniverseQuery = {}): Promise<UniverseStock[]> {
    const params: PageParams = {
      fid: FID_BY_SORT[query.sortBy ?? "amount"],
      po: query.descending === false ? 0 : 1,
      fs: query.mainBoardOnly === true ? MAINBOARD_BOARD_FILTER : BROAD_BOARD_FILTER,
    };

    // The API caps at 100 rows/page but reports the true total. With server-side
    // sort, we only need the first few pages to cover targetCount × margin.
    const first = await this.fetchPage(1, params);
    const totalPages = Math.min(
      Math.max(1, Math.ceil(first.total / this.pageSize)),
      this.maxPages,
    );
    const pagesNeeded =
      query.targetCount === undefined
        ? totalPages
        : Math.min(
            totalPages,
            Math.max(1, Math.ceil((query.targetCount * this.marginFactor) / this.pageSize)),
          );

    if (pagesNeeded <= 1) {
      return first.rows;
    }

    const rows = [...first.rows];
    const remaining: number[] = [];
    for (let page = 2; page <= pagesNeeded; page += 1) {
      remaining.push(page);
    }

    for (let index = 0; index < remaining.length; index += this.concurrency) {
      const batch = remaining.slice(index, index + this.concurrency);
      const results = await Promise.all(
        // A single page failing is non-fatal — degrade the universe, don't abort.
        batch.map((page) => this.fetchPage(page, params).then((result) => result.rows).catch(() => [])),
      );
      for (const pageRows of results) {
        rows.push(...pageRows);
      }

      // Be gentle: spread page requests out so Eastmoney doesn't rate-limit.
      if (index + this.concurrency < remaining.length) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return rows;
  }

  private async fetchPage(page: number, params: PageParams): Promise<{ total: number; rows: UniverseStock[] }> {
    const url =
      `${this.endpoint}?pn=${page}&pz=${this.pageSize}&po=${params.po}&np=1&fltt=2&invt=2` +
      `&fid=${params.fid}&fs=${params.fs}&fields=${FIELDS}`;
    const text = await this.fetchTextWithRetry(url);
    return parseUniversePage(text);
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
      : new UniverseProviderError("Eastmoney universe request failed after retries");
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
        throw new UniverseProviderError(
          `Eastmoney universe request failed: ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }

      const text = await response.text();

      if (text.trim() === "") {
        throw new UniverseProviderError("Eastmoney universe response was empty");
      }

      return text;
    } catch (error) {
      if (error instanceof UniverseProviderError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new UniverseProviderError(`Eastmoney universe request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }

      throw new UniverseProviderError(`Eastmoney universe request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseUniversePage(text: string): { total: number; rows: UniverseStock[] } {
  let parsed: EastmoneyResponse;

  try {
    parsed = JSON.parse(text) as EastmoneyResponse;
  } catch (error) {
    throw new UniverseProviderError("Eastmoney universe response was not valid JSON", { cause: error });
  }

  const diff = parsed.data?.diff;

  if (diff === undefined || diff === null) {
    throw new UniverseProviderError("Eastmoney universe response had no data.diff");
  }

  const rawRows = Array.isArray(diff) ? diff : Object.values(diff);
  const rows: UniverseStock[] = [];

  for (const row of rawRows) {
    const stock = mapRow(row);

    if (stock) {
      rows.push(stock);
    }
  }

  const total = typeof parsed.data?.total === "number" && parsed.data.total > 0
    ? parsed.data.total
    : rows.length;

  return { total, rows };
}

export function parseUniverse(text: string): UniverseStock[] {
  return parseUniversePage(text).rows;
}

function mapRow(row: EastmoneyRow): UniverseStock | undefined {
  const symbol = typeof row.f12 === "string" ? row.f12 : String(row.f12 ?? "");

  if (!/^\d{6}$/.test(symbol)) {
    return undefined;
  }

  const market = row.f13 === 1 || row.f13 === "1" ? "SSE" : "SZSE";
  const name = typeof row.f14 === "string" ? row.f14.trim() : "";

  if (!name) {
    return undefined;
  }

  const candidate = {
    symbol,
    market,
    name,
    latestPrice: numberOrUndefined(row.f2),
    changePct: numberOrUndefined(row.f3),
    turnoverRate: nonNegativeOrUndefined(row.f8),
    volume: nonNegativeOrUndefined(row.f5),
    amount: nonNegativeOrUndefined(row.f6),
    marketCap: nonNegativeOrUndefined(row.f20),
    sector: sectorOrUndefined(row.f100),
    mainNetInflow: numberOrUndefined(row.f62),
    mainNetInflowRatio: numberOrUndefined(row.f184),
  };

  const result = universeStockSchema.safeParse(candidate);
  return result.success ? result.data : undefined;
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

function nonNegativeOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

/** Eastmoney returns "-" or "" when a row has no industry; treat those as absent. */
function sectorOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "-" ? undefined : trimmed.slice(0, 40);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultFetch: UniverseFetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  };
};
