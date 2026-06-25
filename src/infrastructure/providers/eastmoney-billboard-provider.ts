import {
  dragonTigerEntrySchema,
  type DragonTigerEntry,
} from "../../domain/market/index.js";
import { ProviderError } from "./errors.js";

export class BillboardProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BillboardProviderError";
  }
}

export interface BillboardFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export interface BillboardFetchInit {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export type BillboardFetchLike = (
  url: string,
  init?: BillboardFetchInit,
) => Promise<BillboardFetchResponse>;

export interface EastmoneyBillboardProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  pageSize?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  fetchImpl?: BillboardFetchLike;
}

export interface BillboardProvider {
  /** Fetches the 龙虎榜 for one trading date (YYYY-MM-DD), deduped per stock. */
  getDragonTiger(tradeDate: string): Promise<DragonTigerEntry[]>;
}

const DEFAULT_ENDPOINT = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const REPORT_NAME = "RPT_DAILYBILLBOARD_DETAILSNEW";

interface BillboardRow {
  SECURITY_CODE?: unknown;
  SECURITY_NAME_ABBR?: unknown;
  MARKET?: unknown;
  TRADE_DATE?: unknown;
  CLOSE_PRICE?: unknown;
  CHANGE_RATE?: unknown;
  TURNOVERRATE?: unknown;
  NET_BS_AMT?: unknown;
  SUM_BUY_AMT?: unknown;
  SUM_SELL_AMT?: unknown;
  ACCUM_AMOUNT?: unknown;
  EXPLANATION?: unknown;
}

interface BillboardResponse {
  result?: { data?: BillboardRow[] | null } | null;
  success?: boolean;
}

/**
 * Fetches the A-share 龙虎榜 (Dragon-Tiger top-traders list) from Eastmoney's
 * datacenter API for a given trading date. End-of-day data: only meaningful after
 * close. Network-gated, best-effort per row, read-only — no LLM, no broker.
 */
export class EastmoneyBillboardProvider implements BillboardProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly fetchImpl: BillboardFetchLike;

  constructor(options: EastmoneyBillboardProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.pageSize = options.pageSize ?? 500;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 600;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  async getDragonTiger(tradeDate: string): Promise<DragonTigerEntry[]> {
    const filter = encodeURIComponent(`(TRADE_DATE='${tradeDate}')`);
    const url =
      `${this.endpoint}?reportName=${REPORT_NAME}&columns=ALL&source=WEB&client=WEB` +
      `&filter=${filter}&pageNumber=1&pageSize=${this.pageSize}`;
    const text = await this.fetchTextWithRetry(url);
    return parseDragonTiger(text);
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
      : new BillboardProviderError("Eastmoney billboard request failed after retries");
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://data.eastmoney.com/" },
      });
      if (!response.ok) {
        throw new BillboardProviderError(
          `Eastmoney billboard request failed: ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }
      const text = await response.text();
      if (text.trim() === "") {
        throw new BillboardProviderError("Eastmoney billboard response was empty");
      }
      return text;
    } catch (error) {
      if (error instanceof BillboardProviderError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new BillboardProviderError(`Eastmoney billboard request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new BillboardProviderError(`Eastmoney billboard request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Parses the datacenter billboard payload into ONE entry per stock. Eastmoney emits a
 * row per 上榜原因/席位 (all sharing the stock-level NET_BS_AMT), so rows are deduped by
 * code — the stock-level totals are taken once and the distinct reasons accumulated.
 */
export function parseDragonTiger(text: string): DragonTigerEntry[] {
  let parsed: BillboardResponse;
  try {
    parsed = JSON.parse(text) as BillboardResponse;
  } catch (error) {
    throw new BillboardProviderError("Eastmoney billboard response was not valid JSON", { cause: error });
  }

  const rows = parsed.result?.data;
  if (rows === undefined || rows === null) {
    // An empty board (e.g. non-trading day) is valid — no entries, not an error.
    return [];
  }

  const byCode = new Map<string, { entry: DragonTigerEntry; reasons: Set<string> }>();

  for (const row of Array.isArray(rows) ? rows : []) {
    const symbol = typeof row.SECURITY_CODE === "string" ? row.SECURITY_CODE : String(row.SECURITY_CODE ?? "");
    if (!/^\d{6}$/.test(symbol)) {
      continue;
    }
    const reason = typeof row.EXPLANATION === "string" ? row.EXPLANATION.trim() : "";

    const existing = byCode.get(symbol);
    if (existing) {
      if (reason) {
        existing.reasons.add(reason);
      }
      continue;
    }

    const candidate = {
      tradeDate: toDate(row.TRADE_DATE),
      symbol,
      market: row.MARKET === "SH" ? "SSE" : "SZSE",
      name: typeof row.SECURITY_NAME_ABBR === "string" ? row.SECURITY_NAME_ABBR.trim() : "",
      closePrice: nonNegativeOrUndefined(row.CLOSE_PRICE),
      changePct: numberOrUndefined(row.CHANGE_RATE),
      turnoverRate: nonNegativeOrUndefined(row.TURNOVERRATE),
      netBuyAmount: numberOrUndefined(row.NET_BS_AMT) ?? 0,
      buyAmount: nonNegativeOrUndefined(row.SUM_BUY_AMT),
      sellAmount: nonNegativeOrUndefined(row.SUM_SELL_AMT),
      accumAmount: nonNegativeOrUndefined(row.ACCUM_AMOUNT),
      reasons: reason ? [reason] : [],
    };

    const result = dragonTigerEntrySchema.safeParse(candidate);
    if (result.success) {
      byCode.set(symbol, { entry: result.data, reasons: new Set(result.data.reasons) });
    }
  }

  return [...byCode.values()].map(({ entry, reasons }) => ({ ...entry, reasons: [...reasons] }));
}

function toDate(value: unknown): string {
  if (typeof value === "string" && value.length >= 10) {
    return value.slice(0, 10);
  }
  return "";
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

const defaultFetch: BillboardFetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  };
};
