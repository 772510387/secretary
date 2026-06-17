import {
  calculateKlineTechnicalIndicators,
  klineBarSchema,
  normalizeStockSymbol,
  toTencentQuoteSymbol,
  type KlineBar,
  type KlineTechnicalIndicators,
  type StockSymbolInfo,
} from "../../domain/market/index.js";
import { HistoryProviderError } from "./errors.js";
import type { FetchLike } from "./tencent-quote-provider.js";

export interface HistoryProvider {
  getDailyKlines(
    symbol: string | StockSymbolInfo,
    options?: HistoryQueryOptions,
  ): Promise<KlineBar[]>;
  getDailyTechnicalIndicators(
    symbol: string | StockSymbolInfo,
    options?: HistoryQueryOptions,
  ): Promise<KlineTechnicalIndicators>;
}

export interface HistoryQueryOptions {
  count?: number;
  endDate?: string;
  adjustment?: "qfq" | "none";
}

export interface TencentHistoryProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface TencentKlineResponse {
  code?: number;
  msg?: string;
  data?: Record<string, TencentKlinePayload | undefined>;
}

interface TencentKlinePayload {
  day?: unknown;
  qfqday?: unknown;
}

const DEFAULT_TENCENT_HISTORY_ENDPOINT = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const DEFAULT_HISTORY_COUNT = 60;

export class TencentHistoryProvider implements HistoryProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: TencentHistoryProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_TENCENT_HISTORY_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getDailyKlines(
    symbol: string | StockSymbolInfo,
    options: HistoryQueryOptions = {},
  ): Promise<KlineBar[]> {
    const normalized = normalizeStockSymbol(symbol);
    const rawSymbol = toTencentQuoteSymbol(normalized);
    const text = await this.fetchText(this.buildUrl(rawSymbol, options));
    const bars = parseTencentHistoryResponse(text, rawSymbol, normalized);

    if (bars.length === 0) {
      throw new HistoryProviderError("Tencent history response did not contain any valid daily klines");
    }

    return bars;
  }

  async getDailyTechnicalIndicators(
    symbol: string | StockSymbolInfo,
    options: HistoryQueryOptions = {},
  ): Promise<KlineTechnicalIndicators> {
    const bars = await this.getDailyKlines(symbol, options);
    return calculateKlineTechnicalIndicators(bars);
  }

  private buildUrl(rawSymbol: string, options: HistoryQueryOptions): string {
    const count = normalizeCount(options.count);
    const endDate = options.endDate ?? "";
    const adjustment = options.adjustment ?? "qfq";
    const param = [rawSymbol, "day", "", endDate, String(count), adjustment].join(",");
    const separator = this.endpoint.includes("?") ? "&" : "?";

    return `${this.endpoint}${separator}param=${encodeURIComponent(param).replace(/%2C/g, ",")}`;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });

      if (!response.ok) {
        throw new HistoryProviderError(
          `Tencent history request failed with ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }

      return await response.text();
    } catch (error) {
      if (error instanceof HistoryProviderError) {
        throw error;
      }

      throw new HistoryProviderError(`Tencent history request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseTencentHistoryResponse(
  text: string,
  rawSymbol: string,
  symbolInfo: StockSymbolInfo = normalizeStockSymbol(rawSymbol),
): KlineBar[] {
  let json: TencentKlineResponse;

  try {
    json = JSON.parse(text) as TencentKlineResponse;
  } catch {
    return [];
  }

  const payload = json.data?.[rawSymbol];

  if (!payload) {
    return [];
  }

  const rows = selectTencentKlineRows(payload);

  return rows
    .map((row) => parseTencentKlineRow(row, rawSymbol, symbolInfo))
    .filter((bar): bar is KlineBar => bar !== undefined)
    .sort((left, right) => left.tradeDate.localeCompare(right.tradeDate));
}

export function parseTencentKlineRow(
  row: unknown,
  rawSymbol: string,
  symbolInfo: StockSymbolInfo = normalizeStockSymbol(rawSymbol),
): KlineBar | undefined {
  if (!Array.isArray(row) || row.length < 6) {
    return undefined;
  }

  const tradeDate = typeof row[0] === "string" ? row[0] : undefined;
  const open = parseOptionalNumber(row[1]);
  const close = parseOptionalNumber(row[2]);
  const high = parseOptionalNumber(row[3]);
  const low = parseOptionalNumber(row[4]);
  const volume = parseOptionalInteger(row[5]);
  const turnover = parseOptionalNumber(row[6]);

  if (
    !tradeDate ||
    open === undefined ||
    close === undefined ||
    high === undefined ||
    low === undefined ||
    volume === undefined
  ) {
    return undefined;
  }

  const parsed = klineBarSchema.safeParse({
    symbol: symbolInfo.symbol,
    market: symbolInfo.market,
    provider: "tencent",
    period: "1d",
    tradeDate,
    open,
    close,
    high,
    low,
    volume,
    turnover,
    rawSymbol,
  });

  return parsed.success ? parsed.data : undefined;
}

function selectTencentKlineRows(payload: TencentKlinePayload): unknown[] {
  if (Array.isArray(payload.qfqday)) {
    return payload.qfqday;
  }

  if (Array.isArray(payload.day)) {
    return payload.day;
  }

  return [];
}

function normalizeCount(count = DEFAULT_HISTORY_COUNT): number {
  if (!Number.isInteger(count) || count <= 0 || count > 240) {
    throw new HistoryProviderError("history count must be an integer between 1 and 240");
  }

  return count;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw = typeof value === "string" ? value.trim() : value;

  if (raw === "") {
    return undefined;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}
