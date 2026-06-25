import {
  indexSnapshotSchema,
  type IndexId,
  type IndexSnapshot,
} from "../../domain/market/index.js";
import { roundMoney, roundRatio } from "../../domain/portfolio/index.js";
import { IndexProviderError } from "./errors.js";
import { readGbkText } from "./gbk.js";
import type { FetchLike } from "./tencent-quote-provider.js";

export interface IndexProvider {
  getIndex(index: IndexId | TencentIndexSymbol): Promise<IndexSnapshot>;
  getIndexes(indexes?: Array<IndexId | TencentIndexSymbol>): Promise<IndexSnapshot[]>;
}

export interface TencentIndexProviderOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => Date;
}

export interface TencentIndexSymbol {
  indexId: IndexId;
  rawSymbol: string;
}

const DEFAULT_TENCENT_INDEX_ENDPOINT = "https://qt.gtimg.cn/q=";

export const DEFAULT_TENCENT_INDEX_SYMBOLS: readonly TencentIndexSymbol[] = [
  { indexId: "sse_composite", rawSymbol: "sh000001" },
  { indexId: "szse_component", rawSymbol: "sz399001" },
  { indexId: "chinext", rawSymbol: "sz399006" },
  { indexId: "star50", rawSymbol: "sh000688" },
];

const INDEX_ID_BY_RAW_SYMBOL = new Map(
  DEFAULT_TENCENT_INDEX_SYMBOLS.map((item) => [item.rawSymbol, item.indexId] as const),
);

export class TencentIndexProvider implements IndexProvider {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(options: TencentIndexProviderOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_TENCENT_INDEX_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  async getIndex(index: IndexId | TencentIndexSymbol): Promise<IndexSnapshot> {
    const indexes = await this.getIndexes([index]);
    const snapshot = indexes[0];

    if (!snapshot) {
      throw new IndexProviderError(`Tencent index not found for ${resolveTencentIndexSymbol(index).rawSymbol}`);
    }

    return snapshot;
  }

  async getIndexes(indexes: Array<IndexId | TencentIndexSymbol> = [...DEFAULT_TENCENT_INDEX_SYMBOLS]): Promise<IndexSnapshot[]> {
    if (indexes.length === 0) {
      return [];
    }

    const symbols = indexes.map((index) => resolveTencentIndexSymbol(index).rawSymbol);
    const text = await this.fetchText(`${this.endpoint}${encodeURIComponent(symbols.join(",")).replace(/%2C/g, ",")}`);
    const receivedAt = this.now().toISOString();
    const snapshots = parseTencentIndexResponse(text, receivedAt);

    if (snapshots.length === 0) {
      throw new IndexProviderError("Tencent index response did not contain any valid index snapshots");
    }

    return snapshots;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });

      if (!response.ok) {
        throw new IndexProviderError(
          `Tencent index request failed with ${response.status} ${response.statusText ?? ""}`.trim(),
        );
      }

      return await readGbkText(response);
    } catch (error) {
      if (error instanceof IndexProviderError) {
        throw error;
      }

      throw new IndexProviderError(`Tencent index request failed: ${String(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function resolveTencentIndexSymbol(index: IndexId | TencentIndexSymbol): TencentIndexSymbol {
  if (typeof index !== "string") {
    const rawSymbol = index.rawSymbol.trim().toLowerCase();

    if (!/^(sh|sz)\d{6}$/.test(rawSymbol)) {
      throw new IndexProviderError(`Invalid Tencent index symbol: ${index.rawSymbol}`);
    }

    return {
      indexId: index.indexId,
      rawSymbol,
    };
  }

  const symbol = DEFAULT_TENCENT_INDEX_SYMBOLS.find((item) => item.indexId === index);

  if (!symbol) {
    throw new IndexProviderError(`Unsupported index id: ${index}`);
  }

  return symbol;
}

export function parseTencentIndexResponse(text: string, receivedAt: string): IndexSnapshot[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseTencentIndexLine(line, receivedAt))
    .filter((snapshot): snapshot is IndexSnapshot => snapshot !== undefined);
}

export function parseTencentIndexLine(
  line: string,
  receivedAt: string,
): IndexSnapshot | undefined {
  const match = /^v_(sh|sz)(\d{6})="(.*)";?$/.exec(line);

  if (!match) {
    return undefined;
  }

  const rawMarket = match[1]!;
  const code = match[2]!;
  const rawSymbol = `${rawMarket}${code}`;
  const indexId = INDEX_ID_BY_RAW_SYMBOL.get(rawSymbol);

  if (!indexId) {
    return undefined;
  }

  const parts = match[3]!.split("~");
  const name = parts[1]?.trim();
  const providerCode = parts[2]?.trim();
  const latestPrice = parseOptionalNumber(parts[3]);
  const previousClose = parseOptionalNumber(parts[4]);

  if (!name || providerCode !== code || latestPrice === undefined) {
    return undefined;
  }

  const changeAmount =
    previousClose === undefined ? undefined : roundMoney(latestPrice - previousClose);
  const rawChangePct = parseOptionalSignedNumber(parts[32]);
  const changePct =
    rawChangePct !== undefined
      ? roundRatio(rawChangePct / 100)
      : previousClose && previousClose > 0
        ? roundRatio((latestPrice - previousClose) / previousClose)
        : 0;

  return indexSnapshotSchema.parse({
    indexId,
    code,
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
    tradingAllowed: false,
  });
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseOptionalSignedNumber(value: string | undefined): number | undefined {
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
