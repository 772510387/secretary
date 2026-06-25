import { describe, expect, it } from "vitest";
import { isTodayTurnoverMeaningful } from "../../scripts/dev/build-context.js";

/**
 * Clock-driven screen floor: today's 成交额 is only meaningful from the 09:30 open on a
 * weekday. Before then (and on weekends), the pool refresh must not apply a turnover floor.
 * Times below are UTC; Beijing = UTC+8.
 */
describe("isTodayTurnoverMeaningful (A股开盘时间)", () => {
  it("is false before the 09:30 open on a weekday (pre-market)", () => {
    expect(isTodayTurnoverMeaningful("2026-06-25T00:00:00.000Z")).toBe(false); // 08:00 周四
    expect(isTodayTurnoverMeaningful("2026-06-25T01:15:00.000Z")).toBe(false); // 09:15 周四
    expect(isTodayTurnoverMeaningful("2026-06-25T01:29:00.000Z")).toBe(false); // 09:29 周四
  });

  it("is true from the open through post-close on a weekday", () => {
    expect(isTodayTurnoverMeaningful("2026-06-25T01:30:00.000Z")).toBe(true); // 09:30 周四
    expect(isTodayTurnoverMeaningful("2026-06-25T02:00:00.000Z")).toBe(true); // 10:00 周四
    expect(isTodayTurnoverMeaningful("2026-06-25T08:00:00.000Z")).toBe(true); // 16:00 周四 (盘后)
  });

  it("is false on weekends regardless of time", () => {
    expect(isTodayTurnoverMeaningful("2026-06-27T02:00:00.000Z")).toBe(false); // 周六 10:00
    expect(isTodayTurnoverMeaningful("2026-06-28T06:00:00.000Z")).toBe(false); // 周日 14:00
  });
});
