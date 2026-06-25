import {
  universeStockSchema,
  type ScreenSortField,
  type UniverseQuery,
  type UniverseStock,
} from "../../domain/market/index.js";
import { UniverseProviderError, type UniverseProvider } from "./eastmoney-universe-provider.js";
import type { UniverseFetchInit, UniverseFetchLike } from "./eastmoney-universe-provider.js";

export interface SinaUniverseProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  interBatchDelayMs?: number;
  marginFactor?: number;
  fetchImpl?: UniverseFetchLike;
}

const DEFAULT_ENDPOINT =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData";

// Sina sort field per screener sort field (server-side sort, like Eastmoney's fid).
const SORT_BY_FIELD: Record<ScreenSortField, string> = {
  amount: "amount",
  changePct: "changepercent",
  turnoverRate: "turnoverratio",
  marketCap: "mktcap",
  latestPrice: "trade",
};

interface SinaRow {
  symbol?: unknown; // e.g. "sh600519"
  code?: unknown; // "600519"
  name?: unknown;
  trade?: unknown; // latest price
  changepercent?: unknown; // %
  turnoverratio?: unknown; // %
  volume?: unknown; // shares
  amount?: unknown; // yuan
  mktcap?: unknown; // 万元
}

/**
 * Fallback A-share universe source: Sina's Market_Center.getHQNodeData — the same
 * shape as Eastmoney (a server-sorted, paginated full-market list), but a wholly
 * different host so an Eastmoney rate-limit doesn't take it down. Read-only.
 */
export class SinaUniverseProvider implements UniverseProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly interBatchDelayMs: number;
  private readonly marginFactor: number;
  private readonly fetchImpl: UniverseFetchLike;

  constructor(options: SinaUniverseProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pageSize = options.pageSize ?? 80;
    this.maxPages = options.maxPages ?? 80;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 600;
    this.interBatchDelayMs = options.interBatchDelayMs ?? 120;
    this.marginFactor = options.marginFactor ?? 3;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async getUniverse(query: UniverseQuery = {}): Promise<UniverseStock[]> {
    const sort = SORT_BY_FIELD[query.sortBy ?? "amount"];
    const asc = query.descending === false ? 1 : 0;
    const pagesNeeded =
      query.targetCount === undefined
        ? this.maxPages
        : Math.min(
            this.maxPages,
            Math.max(1, Math.ceil((query.targetCount * this.marginFactor) / this.pageSize)),
          );

    const rows: UniverseStock[] = [];
    for (let page = 1; page <= pagesNeeded; page += 1) {
      const pageRows = await this.fetchPage(page, sort, asc);

      if (pageRows.length === 0) {
        break; // past the last page
      }

      rows.push(...pageRows);

      if (page < pagesNeeded) {
        await sleep(this.interBatchDelayMs);
      }
    }

    return rows;
  }

  private async fetchPage(page: number, sort: string, asc: number): Promise<UniverseStock[]> {
    const url =
      `${this.endpoint}?page=${page}&num=${this.pageSize}&sort=${sort}&asc=${asc}` +
      `&node=hs_a&symbol=&_s_r_a=page`;
    const text = await this.fetchTextWithRetry(url);
    return parseSinaUniverse(text);
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
      : new UniverseProviderError("Sina universe request failed after retries");
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: UniverseFetchInit = {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" },
      };
      const response = await this.fetchImpl(url, init);

      if (!response.ok) {
        throw new UniverseProviderError(
          `Sina universe request failed: ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }

      const text = await response.text();

      if (text.trim() === "") {
        throw new UniverseProviderError("Sina universe response was empty");
      }

      return text;
    } catch (error) {
      if (error instanceof UniverseProviderError) {
        throw error;
      }

      if (isAbortError(error)) {
        throw new UniverseProviderError(`Sina universe request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }

      throw new UniverseProviderError(`Sina universe request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseSinaUniverse(text: string): UniverseStock[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UniverseProviderError("Sina universe response was not valid JSON", { cause: error });
  }

  if (parsed === null) {
    return []; // past the last page
  }

  if (!Array.isArray(parsed)) {
    throw new UniverseProviderError("Sina universe response was not a JSON array");
  }

  const stocks: UniverseStock[] = [];
  for (const row of parsed) {
    const stock = mapRow(row as SinaRow);
    if (stock) {
      stocks.push(stock);
    }
  }

  return stocks;
}

function mapRow(row: SinaRow): UniverseStock | undefined {
  const code = typeof row.code === "string" ? row.code : String(row.code ?? "");

  if (!/^\d{6}$/.test(code)) {
    return undefined;
  }

  const rawSymbol = typeof row.symbol === "string" ? row.symbol.toLowerCase() : "";
  const market = rawSymbol.startsWith("sh") ? "SSE" : rawSymbol.startsWith("sz") ? "SZSE" : undefined;

  if (market === undefined) {
    return undefined; // skip 北交所 / unknown prefixes
  }

  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) {
    return undefined;
  }

  const marketCapWan = numberOrUndefined(row.mktcap);
  const candidate = {
    symbol: code,
    market,
    name,
    latestPrice: numberOrUndefined(row.trade),
    changePct: numberOrUndefined(row.changepercent),
    turnoverRate: nonNegativeOrUndefined(row.turnoverratio),
    volume: nonNegativeOrUndefined(row.volume),
    amount: nonNegativeOrUndefined(row.amount),
    // Sina 总市值 is in 万元 → convert to yuan to match the rest of the system.
    marketCap: marketCapWan !== undefined && marketCapWan >= 0 ? marketCapWan * 10_000 : undefined,
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
