import { describe, expect, it } from "vitest";
import {
  renderIntradayMinuteSummary,
  summarizeIntradayMinutes,
  type IntradayMinuteBar,
} from "../../src/domain/market/index.js";
import { parseTencentMinuteResponse } from "../../src/infrastructure/providers/index.js";

const BARS: IntradayMinuteBar[] = [
  { time: "09:30", price: 165, cumVolumeLots: 100, cumTurnover: 1_650_000 },
  { time: "09:31", price: 170, cumVolumeLots: 200, cumTurnover: 3_350_000 },
  { time: "14:30", price: 175, cumVolumeLots: 900, cumTurnover: 15_000_000 },
  { time: "15:00", price: 177, cumVolumeLots: 1000, cumTurnover: 17_000_000 },
];

describe("summarizeIntradayMinutes", () => {
  it("derives day range, VWAP, change and range position", () => {
    const s = summarizeIntradayMinutes({ symbol: "000988", name: "华工科技", bars: BARS, previousClose: 160 });
    expect(s.degraded).toBe(false);
    expect(s.open).toBe(165);
    expect(s.last).toBe(177);
    expect(s.high).toBe(177);
    expect(s.low).toBe(165);
    expect(s.vwap).toBe(170); // 17,000,000 / (1000 * 100)
    expect(s.changePct).toBeCloseTo(0.1063, 4); // (177-160)/160
    expect(s.rangePosition).toBe(1); // last == high
    expect(s.lastTime).toBe("15:00");
    expect(s.pointCount).toBe(4);
  });

  it("renders a concise citeable line", () => {
    const line = renderIntradayMinuteSummary(
      summarizeIntradayMinutes({ symbol: "000988", name: "华工科技", bars: BARS, previousClose: 160 }),
    );
    expect(line).toContain("华工科技(000988) 分时");
    expect(line).toContain("现价177");
    expect(line).toContain("VWAP170(站上均价线)");
    expect(line).toContain("全天165~177");
  });

  it("degrades honestly on empty data", () => {
    const s = summarizeIntradayMinutes({ symbol: "000988", bars: [], previousClose: 160 });
    expect(s.degraded).toBe(true);
    expect(s.note).toBe("无分时数据");
    expect(renderIntradayMinuteSummary(s)).toContain("无分时数据");
  });
});

describe("parseTencentMinuteResponse", () => {
  it("parses the minute/query JSON into bars + previousClose", () => {
    const payload = JSON.stringify({
      code: 0,
      data: {
        sz000988: {
          qt: { sz000988: ["1", "华工科技", "000988", "177.03", "160.94"] },
          data: {
            date: "20260629",
            data: ["0930 165.00 100 1650000", "1500 177.03 1141374 19961387551.54"],
          },
        },
      },
    });
    const series = parseTencentMinuteResponse(payload, "sz000988");
    expect(series.symbol).toBe("000988");
    expect(series.name).toBe("华工科技");
    expect(series.previousClose).toBe(160.94);
    expect(series.bars).toHaveLength(2);
    expect(series.bars[0]).toEqual({ time: "09:30", price: 165, cumVolumeLots: 100, cumTurnover: 1_650_000 });
    expect(series.bars[1]!.time).toBe("15:00");
    expect(series.bars[1]!.price).toBe(177.03);
  });

  it("throws when the symbol node is missing", () => {
    expect(() => parseTencentMinuteResponse(JSON.stringify({ data: {} }), "sz000988")).toThrow();
  });
});
