import { stockSymbolInfoSchema, type StockSymbolInfo } from "./schemas.js";

export function inferAshareMarket(symbol: string): StockSymbolInfo["market"] {
  if (/^(600|601|603|605|688)\d{3}$/.test(symbol)) {
    return "SSE";
  }

  if (/^(000|001|002|003|300)\d{3}$/.test(symbol)) {
    return "SZSE";
  }

  throw new MarketSymbolError(`Cannot infer A-share market for symbol ${symbol}`);
}

export function normalizeStockSymbol(input: string | StockSymbolInfo): StockSymbolInfo {
  if (typeof input !== "string") {
    return stockSymbolInfoSchema.parse(input);
  }

  const trimmed = input.trim();
  const match = /^(?:(sh|sz))?(\d{6})$/i.exec(trimmed);

  if (!match) {
    throw new MarketSymbolError(`Invalid A-share symbol ${input}`);
  }

  const prefix = match[1]?.toLowerCase();
  const symbol = match[2]!;
  const market = prefix === "sh" ? "SSE" : prefix === "sz" ? "SZSE" : inferAshareMarket(symbol);

  return stockSymbolInfoSchema.parse({ symbol, market });
}

export function toTencentQuoteSymbol(input: string | StockSymbolInfo): string {
  const symbol = normalizeStockSymbol(input);
  return `${symbol.market === "SSE" ? "sh" : "sz"}${symbol.symbol}`;
}

export class MarketSymbolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSymbolError";
  }
}

