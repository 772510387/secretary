import { toTencentQuoteSymbol, type StockSymbolInfo } from "../../domain/market/index.js";
import { ProviderError } from "./errors.js";

export class MoneyFlowProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MoneyFlowProviderError";
  }
}

/** One stock's latest-day capital flow (the 北向 replacement signal, per stock). */
export interface StockMoneyFlow {
  symbol: string;
  /** Trading date of this flow (YYYY-MM-DD). */
  date: string;
  /** 主力净流入额 (yuan, CAN be negative) — Sina r0_net (超大单+大单 net). */
  mainNetInflow: number;
  /** 主力净流入率 (%). Sina r0_ratio × 100. */
  mainNetInflowRatio?: number;
  /** 全单净流入额 (yuan) — Sina netamount. */
  netInflow?: number;
}

export interface SinaFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

export type SinaFetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<SinaFetchResponse>;

export interface SinaMoneyFlowProviderOptions {
  endpoint?: string;
  /** Batch ranking endpoint (one call → many stocks' 主力净流入). */
  rankingEndpoint?: string;
  timeoutMs?: number;
  /** Max concurrent per-stock requests (Sina is one-stock-per-call). */
  concurrency?: number;
  fetchImpl?: SinaFetchLike;
}

const DEFAULT_ENDPOINT =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_qsfx_zjlrqs";
const DEFAULT_RANKING_ENDPOINT =
  "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj";

interface SinaMoneyFlowRow {
  opendate?: unknown;
  netamount?: unknown;
  r0_net?: unknown;
  r0_ratio?: unknown;
}

/**
 * Fetches per-stock 主力资金净流入 from Sina (the source that is actually reachable —
 * Tencent's ff_ codes and ddhgt controllers are dead, and Eastmoney's clist needs a
 * Referer the sandbox proxy can't clear). One call per stock, so use it for a BOUNDED
 * set (held positions + key picks), not the whole 100池. Best-effort, read-only.
 */
export class SinaMoneyFlowProvider {
  private readonly endpoint: string;
  private readonly rankingEndpoint: string;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly fetchImpl: SinaFetchLike;

  constructor(options: SinaMoneyFlowProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.rankingEndpoint = options.rankingEndpoint ?? DEFAULT_RANKING_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.concurrency = options.concurrency ?? 6;
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
  }

  /**
   * 池级 (batch) 主力净流入: ONE call returns many stocks ranked by 成交额, each with
   * `r0_net`. Returns a 6-digit-symbol → 主力净流入 (yuan) map for enriching the pool.
   * Best-effort — unreachable/empty → empty map.
   */
  async getMoneyFlowRanking(count = 500): Promise<Map<string, number>> {
    const url = `${this.rankingEndpoint}?page=1&num=${count}&sort=amount&asc=0&fenlei=1`;
    const text = await this.fetchText(url);
    return parseSinaMoneyFlowRanking(text);
  }

  async getMoneyFlow(symbol: string | StockSymbolInfo): Promise<StockMoneyFlow | undefined> {
    const daima = toTencentQuoteSymbol(symbol); // sh600519 / sz000001 — same shape Sina expects
    const url = `${this.endpoint}?page=1&num=1&sort=opendate&asc=0&daima=${daima}`;
    const text = await this.fetchText(url);
    return parseSinaMoneyFlow(text, daima.replace(/^(sh|sz)/, ""));
  }

  /** Fetches money flow for several symbols (bounded concurrency); failures → omitted. */
  async getMoneyFlows(symbols: Array<string | StockSymbolInfo>): Promise<Map<string, StockMoneyFlow>> {
    const out = new Map<string, StockMoneyFlow>();
    for (let index = 0; index < symbols.length; index += this.concurrency) {
      const batch = symbols.slice(index, index + this.concurrency);
      const results = await Promise.all(
        batch.map((symbol) => this.getMoneyFlow(symbol).catch(() => undefined)),
      );
      for (const flow of results) {
        if (flow) {
          out.set(flow.symbol, flow);
        }
      }
    }
    return out;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://finance.sina.com.cn/" },
      });
      if (!response.ok) {
        throw new MoneyFlowProviderError(
          `Sina money-flow request failed: ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }
      const text = await response.text();
      if (text.trim() === "") {
        throw new MoneyFlowProviderError("Sina money-flow response was empty");
      }
      return text;
    } catch (error) {
      if (error instanceof MoneyFlowProviderError) {
        throw error;
      }
      throw new MoneyFlowProviderError(`Sina money-flow request failed: ${String(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Parses Sina's `[{opendate,netamount,r0_net,r0_ratio,...}]` into the latest StockMoneyFlow. */
export function parseSinaMoneyFlow(text: string, symbol: string): StockMoneyFlow | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MoneyFlowProviderError("Sina money-flow response was not valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return undefined;
  }
  const row = parsed[0] as SinaMoneyFlowRow;
  const mainNetInflow = numberOrUndefined(row.r0_net);
  const date = typeof row.opendate === "string" ? row.opendate.slice(0, 10) : "";
  if (mainNetInflow === undefined || date === "") {
    return undefined;
  }
  const ratio = numberOrUndefined(row.r0_ratio);
  return {
    symbol,
    date,
    mainNetInflow,
    mainNetInflowRatio: ratio === undefined ? undefined : ratio * 100,
    netInflow: numberOrUndefined(row.netamount),
  };
}

/** Parses the Sina batch ranking `[{symbol:"sz300502",r0_net:"..."},…]` → 6-digit → 主力净流入. */
export function parseSinaMoneyFlowRanking(text: string): Map<string, number> {
  const out = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) {
    return out;
  }
  for (const row of parsed) {
    if (typeof row !== "object" || row === null) {
      continue;
    }
    const record = row as { symbol?: unknown; r0_net?: unknown };
    const rawSymbol = typeof record.symbol === "string" ? record.symbol : "";
    const symbol = rawSymbol.replace(/^(sh|sz|bj)/i, "");
    const r0Net = numberOrUndefined(record.r0_net);
    if (/^\d{6}$/.test(symbol) && r0Net !== undefined) {
      out.set(symbol, r0Net);
    }
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

const defaultFetch: SinaFetchLike = async (url, init) => {
  const response = await globalThis.fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: () => response.text(),
  };
};
