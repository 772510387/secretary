import { describe, expect, it } from "vitest";
import { resolveTrailingDecisionWindow } from "../../src/app/trailing-decision-window.js";

describe("resolveTrailingDecisionWindow", () => {
  it("ends a settle-lag before today and never includes today", () => {
    // 2026-06-29 is a Monday (Beijing). 6 trading days back = 2026-06-19 (Fri).
    const window = resolveTrailingDecisionWindow({
      now: "2026-06-29T01:00:00.000Z",
      windowTradingDays: 5,
      settleLagTradingDays: 6,
    });
    expect(window.to).toBe("2026-06-19");
    // 5 trading days inclusive ending 06-19 (Fri): 06-19,18,17,16,15 → starts 06-15 (Mon).
    expect(window.from).toBe("2026-06-15");
  });

  it("skips weekends when stepping back", () => {
    const window = resolveTrailingDecisionWindow({
      now: "2026-06-29T01:00:00.000Z",
      windowTradingDays: 1,
      settleLagTradingDays: 1,
    });
    // 1 trading day before Monday 06-29 is Friday 06-26, not Sunday 06-28.
    expect(window.to).toBe("2026-06-26");
    expect(window.from).toBe("2026-06-26");
  });

  it("uses Beijing calendar date for the boundary", () => {
    // 2026-06-29T20:00Z is 2026-06-30 04:00 Beijing (Tuesday).
    const window = resolveTrailingDecisionWindow({
      now: "2026-06-29T20:00:00.000Z",
      windowTradingDays: 1,
      settleLagTradingDays: 1,
    });
    // 1 trading day before Tuesday 06-30 is Monday 06-29.
    expect(window.to).toBe("2026-06-29");
  });

  it("falls back to sane defaults for invalid inputs", () => {
    const window = resolveTrailingDecisionWindow({
      now: "2026-06-29T01:00:00.000Z",
      windowTradingDays: 0,
      settleLagTradingDays: -3,
    });
    // defaults: window 10, lag 6 → to = 2026-06-19, from = 10 trading days inclusive = 2026-06-08 (Mon).
    expect(window.to).toBe("2026-06-19");
    expect(window.from).toBe("2026-06-08");
  });
});
