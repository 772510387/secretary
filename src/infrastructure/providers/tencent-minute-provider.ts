import {
  summarizeIntradayMinutes,
  toTencentQuoteSymbol,
  type IntradayMinuteBar,
  type IntradayMinuteSummary,
  type StockSymbolInfo,
} from "../../domain/market/index.js";
import { QuoteProviderError } from "./errors.js";
import type { FetchLike } from "./tencent-quote-provider.js";

export interface TencentMinuteProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface IntradayMinuteSeries {
  symbol: string;
  name?: string;
  previousClose?: number;
  bars: IntradayMinuteBar[];
}

/**
 * Today's per-minute (分时) series from Tencent's free `minute/query` endpoint — the
 * "精确到分" source. Returns the raw bars and a derived {@link IntradayMinuteSummary}
 * (VWAP / day range / tail momentum) for the brain to cite. One symbol per request;
 * `getIntradaySummaries` fans out a bounded set and never throws (degrades per symbol).
 */
export class TencentMinuteProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: TencentMinuteProviderOptions = {}) {
    this.endpoint = options.endpoint ?? "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=";
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getIntradaySeries(symbol: string | StockSymbolInfo): Promise<IntradayMinuteSeries> {
    const code = toTencentQuoteSymbol(symbol);
    const text = await this.fetchText(`${this.endpoint}${code}`);
    return parseTencentMinuteResponse(text, code);
  }

  async getIntradaySummary(symbol: string | StockSymbolInfo): Promise<IntradayMinuteSummary> {
    const series = await this.getIntradaySeries(symbol);
    return summarizeIntradayMinutes(series);
  }

  /** Fetches summaries for several symbols; a per-symbol failure degrades to a `degraded` summary. */
  async getIntradaySummaries(
    symbols: Array<string | StockSymbolInfo>,
  ): Promise<IntradayMinuteSummary[]> {
    const results: IntradayMinuteSummary[] = [];
    for (const symbol of symbols) {
      try {
        results.push(await this.getIntradaySummary(symbol));
      } catch (error) {
        results.push({
          symbol: typeof symbol === "string" ? symbol : symbol.symbol,
          name: typeof symbol === "string" ? undefined : symbol.name,
          pointCount: 0,
          degraded: true,
          note: `分时拉取失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return results;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new QuoteProviderError(
          `Tencent minute request failed with ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }
      return await response.text();
    } catch (error) {
      if (error instanceof QuoteProviderError) {
        throw error;
      }
      throw new QuoteProviderError(`Tencent minute request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Parses the `minute/query` JSON. Shape:
 *   { data: { sz000988: { qt: { sz000988: [..quote..] }, data: { date, data: ["HHMM price cumVolLots cumTurnover", ...] } } } }
 * The quote sub-array (Tencent qt format) carries name[1] and previousClose[4].
 */
export function parseTencentMinuteResponse(text: string, code: string): IntradayMinuteSeries {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new QuoteProviderError(`Tencent minute response was not valid JSON: ${String(error)}`);
  }

  const node = (json as Record<string, any>)?.data?.[code];
  if (!node) {
    throw new QuoteProviderError(`Tencent minute response missing data for ${code}`);
  }

  const rawBars: unknown = node?.data?.data;
  const lines: string[] = Array.isArray(rawBars) ? rawBars.filter((line): line is string => typeof line === "string") : [];

  const quoteArray: unknown = node?.qt?.[code];
  const name = Array.isArray(quoteArray) ? toStringOrUndefined(quoteArray[1]) : undefined;
  const previousClose = Array.isArray(quoteArray) ? toNumberOrUndefined(quoteArray[4]) : undefined;

  const bars: IntradayMinuteBar[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const time = formatMinuteTime(parts[0]);
    const price = toNumberOrUndefined(parts[1]);
    if (time === undefined || price === undefined) {
      continue;
    }
    bars.push({
      time,
      price,
      cumVolumeLots: toNumberOrUndefined(parts[2]),
      cumTurnover: toNumberOrUndefined(parts[3]),
    });
  }

  return { symbol: stripMarketPrefix(code), name, previousClose, bars };
}

function formatMinuteTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const digits = value.trim();
  // "0930" or "093000" → "09:30"
  if (/^\d{4}$/.test(digits)) {
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  }
  if (/^\d{6}$/.test(digits)) {
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  }
  return undefined;
}

function stripMarketPrefix(code: string): string {
  const match = /^(?:sh|sz)?(\d{6})$/.exec(code);
  return match ? match[1]! : code;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}
