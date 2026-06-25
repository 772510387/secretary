/**
 * 封单/一字板 detection from a level-1 盘口 snapshot (the data the audit said had
 * "no source" — it was in the Tencent quote string all along, just unparsed).
 *
 * 涨停封板: 现价 = 涨停价 且卖盘被扫空 → 封单 = 买一量. 一字板: 开=高=低=涨停价 (从未打开).
 * 跌停封板: 现价 = 跌停价 → 封单 = 卖一量. Pure of network/LLM.
 */
export type SealBoardState = "limit_up" | "limit_down";

export interface SealBoard {
  state: SealBoardState;
  /** 一字板 (opened, ran, and closed at the limit — never traded off it). */
  isOneWord: boolean;
  /** 封单量 (手). */
  sealVolumeLots: number;
  /** 封单金额 (yuan) = 封单量 × 100 × 封板价. */
  sealAmount: number;
  /** The computed 涨停/跌停 price. */
  limitPrice: number;
}

export interface SealBoardInput {
  symbol: string;
  latestPrice: number;
  previousClose?: number;
  openPrice?: number;
  highPrice?: number;
  lowPrice?: number;
  bid1Price?: number;
  bid1Volume?: number;
  ask1Price?: number;
  ask1Volume?: number;
  /** Daily limit ratio; main board = 0.10 (the only board we trade). ST would be 0.05. */
  limitRatio?: number;
}

const PRICE_EPSILON = 0.005; // half a 分: float-safe limit-price compare.

/**
 * Returns the seal-board summary when the stock is locked at its 涨停/跌停 price, else
 * undefined. Needs previousClose to derive the limit price; degrades to undefined without it.
 */
export function computeSealBoard(input: SealBoardInput): SealBoard | undefined {
  const prevClose = input.previousClose;
  if (prevClose === undefined || prevClose <= 0) {
    return undefined;
  }
  const ratio = input.limitRatio ?? 0.1;
  const upPrice = round2(prevClose * (1 + ratio));
  const downPrice = round2(prevClose * (1 - ratio));

  if (Math.abs(input.latestPrice - upPrice) <= PRICE_EPSILON) {
    const lots = input.bid1Volume ?? 0; // 买一量 = 涨停封单
    return {
      state: "limit_up",
      isOneWord: isOneWordBoard(input, upPrice),
      sealVolumeLots: lots,
      sealAmount: lots * 100 * (input.bid1Price ?? upPrice),
      limitPrice: upPrice,
    };
  }

  if (Math.abs(input.latestPrice - downPrice) <= PRICE_EPSILON) {
    const lots = input.ask1Volume ?? 0; // 卖一量 = 跌停封单
    return {
      state: "limit_down",
      isOneWord: isOneWordBoard(input, downPrice),
      sealVolumeLots: lots,
      sealAmount: lots * 100 * (input.ask1Price ?? downPrice),
      limitPrice: downPrice,
    };
  }

  return undefined;
}

/** Renders a compact 封单 tag, e.g. "封8.8亿一字" / "封1.2亿". "" when no seal. */
export function renderSealTag(seal: SealBoard | undefined): string {
  if (seal === undefined || seal.sealVolumeLots <= 0) {
    return "";
  }
  return `封${(seal.sealAmount / 1e8).toFixed(1)}亿${seal.isOneWord ? "一字" : ""}`;
}

function isOneWordBoard(input: SealBoardInput, limitPrice: number): boolean {
  return (
    approxEq(input.openPrice, limitPrice) &&
    approxEq(input.highPrice, limitPrice) &&
    approxEq(input.lowPrice, limitPrice)
  );
}

function approxEq(value: number | undefined, target: number): boolean {
  return value !== undefined && Math.abs(value - target) <= PRICE_EPSILON;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
