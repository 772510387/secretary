import {
  quoteSnapshotSchema,
  toTencentQuoteSymbol,
  type QuoteSnapshot,
  type StockSymbolInfo,
} from "../../domain/market/index.js";
import { roundMoney, roundRatio } from "../../domain/portfolio/index.js";
import { QuoteProviderError } from "./errors.js";
import { readGbkText } from "./gbk.js";

export interface QuoteProvider {
  getQuote(symbol: string | StockSymbolInfo): Promise<QuoteSnapshot>;
  getQuotes(symbols: Array<string | StockSymbolInfo>): Promise<QuoteSnapshot[]>;
}

export interface TencentQuoteProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
  /** Raw bytes — used to decode the GBK-encoded Tencent body; optional for mocks. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export class TencentQuoteProvider implements QuoteProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(options: TencentQuoteProviderOptions = {}) {
    this.endpoint = options.endpoint ?? "https://qt.gtimg.cn/q=";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  async getQuote(symbol: string | StockSymbolInfo): Promise<QuoteSnapshot> {
    const quotes = await this.getQuotes([symbol]);
    const quote = quotes[0];

    if (!quote) {
      throw new QuoteProviderError(`Tencent quote not found for ${toTencentQuoteSymbol(symbol)}`);
    }

    return quote;
  }

  async getQuotes(symbols: Array<string | StockSymbolInfo>): Promise<QuoteSnapshot[]> {
    if (symbols.length === 0) {
      return [];
    }

    const query = symbols.map(toTencentQuoteSymbol).join(",");
    const text = await this.fetchText(`${this.endpoint}${encodeURIComponent(query).replace(/%2C/g, ",")}`);
    const receivedAt = this.now().toISOString();
    const quotes = parseTencentQuoteResponse(text, receivedAt);

    if (quotes.length === 0) {
      throw new QuoteProviderError("Tencent quote response did not contain any valid quotes");
    }

    return quotes;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });

      if (!response.ok) {
        throw new QuoteProviderError(
          `Tencent quote request failed with ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }

      return await readGbkText(response);
    } catch (error) {
      if (error instanceof QuoteProviderError) {
        throw error;
      }

      throw new QuoteProviderError(`Tencent quote request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseTencentQuoteResponse(text: string, receivedAt: string): QuoteSnapshot[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseTencentQuoteLine(line, receivedAt))
    .filter((quote): quote is QuoteSnapshot => quote !== undefined);
}

export function parseTencentQuoteLine(
  line: string,
  receivedAt: string,
): QuoteSnapshot | undefined {
  const match = /^v_(sh|sz)(\d{6})="(.*)";?$/.exec(line);

  if (!match) {
    return undefined;
  }

  const rawMarket = match[1]!;
  const rawSymbol = `${rawMarket}${match[2]!}`;
  const parts = match[3]!.split("~");
  const symbol = parts[2]?.trim();
  const name = parts[1]?.trim();
  const latestPrice = parseOptionalNumber(parts[3]);
  const previousClose = parseOptionalNumber(parts[4]);

  if (!symbol || !name || latestPrice === undefined) {
    return undefined;
  }

  const changeAmount =
    previousClose === undefined ? undefined : roundMoney(latestPrice - previousClose);
  const rawChangePct = parseOptionalNumber(parts[32]);
  const changePct =
    rawChangePct !== undefined
      ? roundRatio(rawChangePct / 100)
      : previousClose && previousClose > 0
        ? roundRatio((latestPrice - previousClose) / previousClose)
        : 0;

  return quoteSnapshotSchema.parse({
    symbol,
    market: rawMarket === "sh" ? "SSE" : "SZSE",
    name,
    provider: "tencent",
    latestPrice,
    previousClose,
    openPrice: parseOptionalNumber(parts[5]),
    highPrice: parseOptionalNumber(parts[33]),
    lowPrice: parseOptionalNumber(parts[34]),
    changeAmount,
    changePct,
    volume: parseOptionalInteger(parts[6]),
    turnover: parseOptionalNumber(parts[37]),
    providerTime: parseTencentProviderTime(parts[30]),
    receivedAt,
    rawSymbol,
  });
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  const parsed = parseOptionalNumber(value);
  return parsed === undefined ? undefined : Math.trunc(parsed);
}

function parseTencentProviderTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());

  if (!match) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

