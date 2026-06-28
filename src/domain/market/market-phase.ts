/**
 * 行情相位 (market phase): which part of the A-share trading day a timestamp falls in.
 * Deterministic from Beijing minute-of-day + day-of-week. Lets the brain distinguish
 * 集合竞价价 (9:15-9:25) from 开盘价 (9:30) from 盘中价 — a "相位标签，非数据源" gap the
 * audit flagged. Pure: same inputs → same phase.
 */
export type MarketPhase =
  | "pre_market" // 盘前 (< 9:15)
  | "call_auction" // 集合竞价 (9:15-9:30)
  | "continuous_am" // 上午连续竞价 (9:30-11:30)
  | "midday_break" // 午间休市 (11:30-13:00)
  | "continuous_pm" // 下午连续竞价 (13:00-15:00)
  | "post_close" // 盘后 (15:00-15:30)
  | "closed"; // 收盘后 / 非交易日

export interface MarketPhaseInput {
  /** Beijing minute-of-day, 0..1439 (hours*60 + minutes). */
  minuteOfDay: number;
  /** Beijing ISO day-of-week, 1=Mon … 7=Sun. */
  dayOfWeek: number;
}

const OPEN_AUCTION = 9 * 60 + 15; // 555
const CONTINUOUS_AM = 9 * 60 + 30; // 570
const MORNING_CLOSE = 11 * 60 + 30; // 690
const CONTINUOUS_PM = 13 * 60; // 780
const MARKET_CLOSE = 15 * 60; // 900
const POST_CLOSE_END = 15 * 60 + 30; // 930

export function resolveMarketPhase(input: MarketPhaseInput): MarketPhase {
  if (input.dayOfWeek > 5) {
    return "closed"; // weekend
  }
  const minute = input.minuteOfDay;
  if (minute < OPEN_AUCTION) {
    return "pre_market";
  }
  if (minute < CONTINUOUS_AM) {
    return "call_auction";
  }
  if (minute < MORNING_CLOSE) {
    return "continuous_am";
  }
  if (minute < CONTINUOUS_PM) {
    return "midday_break";
  }
  if (minute < MARKET_CLOSE) {
    return "continuous_pm";
  }
  if (minute < POST_CLOSE_END) {
    return "post_close";
  }
  return "closed";
}

export const MARKET_PHASE_LABEL: Record<MarketPhase, string> = {
  pre_market: "盘前",
  call_auction: "集合竞价",
  continuous_am: "上午盘中",
  midday_break: "午间休市",
  continuous_pm: "下午盘中",
  post_close: "盘后",
  closed: "收盘后/非交易时段",
};

/** True while continuous matching is live (现价是真实成交价，非竞价/前收). */
export function isContinuousTrading(phase: MarketPhase): boolean {
  return phase === "continuous_am" || phase === "continuous_pm";
}
