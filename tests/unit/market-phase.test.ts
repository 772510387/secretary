import { describe, expect, it } from "vitest";
import {
  MARKET_PHASE_LABEL,
  isContinuousTrading,
  resolveMarketPhase,
} from "../../src/domain/market/index.js";

const wed = 3; // a weekday

describe("resolveMarketPhase", () => {
  it("maps Beijing minute-of-day to the right A-share phase on a weekday", () => {
    const at = (h: number, m: number) => resolveMarketPhase({ minuteOfDay: h * 60 + m, dayOfWeek: wed });
    expect(at(9, 0)).toBe("pre_market");
    expect(at(9, 15)).toBe("call_auction"); // 集合竞价 starts
    expect(at(9, 25)).toBe("call_auction");
    expect(at(9, 30)).toBe("continuous_am"); // 开盘
    expect(at(11, 29)).toBe("continuous_am");
    expect(at(11, 30)).toBe("midday_break");
    expect(at(12, 0)).toBe("midday_break");
    expect(at(13, 0)).toBe("continuous_pm");
    expect(at(14, 59)).toBe("continuous_pm");
    expect(at(15, 0)).toBe("post_close");
    expect(at(15, 30)).toBe("closed");
    expect(at(20, 0)).toBe("closed");
  });

  it("is always closed on weekends", () => {
    expect(resolveMarketPhase({ minuteOfDay: 10 * 60, dayOfWeek: 6 })).toBe("closed");
    expect(resolveMarketPhase({ minuteOfDay: 10 * 60, dayOfWeek: 7 })).toBe("closed");
  });

  it("only continuous phases count as live matching; has Chinese labels", () => {
    expect(isContinuousTrading("continuous_am")).toBe(true);
    expect(isContinuousTrading("continuous_pm")).toBe(true);
    expect(isContinuousTrading("call_auction")).toBe(false);
    expect(MARKET_PHASE_LABEL.call_auction).toBe("集合竞价");
    expect(MARKET_PHASE_LABEL.continuous_am).toBe("上午盘中");
  });
});
