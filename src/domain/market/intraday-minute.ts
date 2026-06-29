/**
 * Intraday minute (分时) series — the "精确到分" layer. The provider fetches today's
 * per-minute prints; these PURE helpers derive a small, citeable summary (VWAP, day
 * range, tail momentum, range position) so the brain can reason about intraday 量价
 * without us shipping 240 raw points into the prompt. No network, no IO here.
 */

export interface IntradayMinuteBar {
  /** Beijing HH:MM of the print. */
  time: string;
  price: number;
  /** Cumulative volume in 手 (lots) up to this minute, when the source provides it. */
  cumVolumeLots?: number;
  /** Cumulative turnover in 元 up to this minute, when the source provides it. */
  cumTurnover?: number;
}

export interface IntradayMinuteSummary {
  symbol: string;
  name?: string;
  pointCount: number;
  open?: number;
  high?: number;
  low?: number;
  last?: number;
  lastTime?: string;
  /** Volume-weighted average price for the day (cumTurnover / cumShares), when available. */
  vwap?: number;
  previousClose?: number;
  /** last vs previousClose. */
  changePct?: number;
  /** Last ~30-minute price return — intraday momentum / 尾盘动向. */
  tailReturn30m?: number;
  /** Where `last` sits in the day's [low, high] range, 0..1 (1 = at the high). */
  rangePosition?: number;
  /** True when there is no usable minute data (summary fields are mostly undefined). */
  degraded: boolean;
  note?: string;
}

const TAIL_WINDOW_MINUTES = 30;

export function summarizeIntradayMinutes(input: {
  symbol: string;
  name?: string;
  bars: readonly IntradayMinuteBar[];
  previousClose?: number;
}): IntradayMinuteSummary {
  const bars = input.bars.filter((bar) => Number.isFinite(bar.price) && bar.price > 0);

  if (bars.length === 0) {
    return {
      symbol: input.symbol,
      name: input.name,
      pointCount: 0,
      previousClose: input.previousClose,
      degraded: true,
      note: "无分时数据",
    };
  }

  const prices = bars.map((bar) => bar.price);
  const open = prices[0]!;
  const last = prices[prices.length - 1]!;
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const lastBar = bars[bars.length - 1]!;

  const vwap =
    lastBar.cumTurnover !== undefined &&
    lastBar.cumVolumeLots !== undefined &&
    lastBar.cumVolumeLots > 0
      ? round2(lastBar.cumTurnover / (lastBar.cumVolumeLots * 100))
      : undefined;

  const changePct =
    input.previousClose !== undefined && input.previousClose > 0
      ? round4((last - input.previousClose) / input.previousClose)
      : undefined;

  const tailIndex = bars.length > TAIL_WINDOW_MINUTES ? bars.length - 1 - TAIL_WINDOW_MINUTES : 0;
  const tailBase = prices[tailIndex]!;
  const tailReturn30m = tailBase > 0 ? round4((last - tailBase) / tailBase) : undefined;

  const rangePosition = high > low ? round2((last - low) / (high - low)) : 1;

  return {
    symbol: input.symbol,
    name: input.name,
    pointCount: bars.length,
    open: round2(open),
    high: round2(high),
    low: round2(low),
    last: round2(last),
    lastTime: lastBar.time,
    vwap,
    previousClose: input.previousClose,
    changePct,
    tailReturn30m,
    rangePosition,
    degraded: false,
  };
}

export function renderIntradayMinuteSummary(summary: IntradayMinuteSummary): string {
  const label = `${summary.name ? `${summary.name}(${summary.symbol})` : summary.symbol} 分时`;
  if (summary.degraded || summary.last === undefined) {
    return `${label}：${summary.note ?? "数据缺失"}`;
  }

  const parts: string[] = [`现价${summary.last}`];
  if (summary.changePct !== undefined) {
    parts.push(`${formatPct(summary.changePct)}`);
  }
  if (summary.high !== undefined && summary.low !== undefined) {
    parts.push(`全天${summary.low}~${summary.high}`);
  }
  if (summary.vwap !== undefined) {
    parts.push(`VWAP${summary.vwap}${summary.last >= summary.vwap ? "(站上均价线)" : "(跌破均价线)"}`);
  }
  if (summary.rangePosition !== undefined) {
    parts.push(`位置${summary.rangePosition.toFixed(2)}`);
  }
  if (summary.tailReturn30m !== undefined) {
    parts.push(`尾盘30分${formatPct(summary.tailReturn30m)}`);
  }
  parts.push(`(${summary.pointCount}点${summary.lastTime ? `截至${summary.lastTime}` : ""})`);
  return `${label}：${parts.join(" ")}`;
}

function formatPct(ratio: number): string {
  const pct = ratio * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
