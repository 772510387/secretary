import { describe, expect, it } from "vitest";
import { computeSealBoard, renderSealTag } from "../../src/domain/market/index.js";

describe("computeSealBoard", () => {
  it("detects 涨停封板 with 封单 = 买一量 (real 长电科技 600584 case)", () => {
    // prevClose 94.70 → 涨停价 104.17; 卖盘空, 买一量 84205手 = 封单.
    const seal = computeSealBoard({
      symbol: "600584",
      latestPrice: 104.17,
      previousClose: 94.7,
      openPrice: 100.0,
      highPrice: 104.17,
      lowPrice: 99.99,
      bid1Price: 104.17,
      bid1Volume: 84205,
      ask1Price: 0,
      ask1Volume: 0,
    });
    expect(seal?.state).toBe("limit_up");
    expect(seal?.sealVolumeLots).toBe(84205);
    expect(seal?.limitPrice).toBe(104.17);
    expect(seal?.isOneWord).toBe(false); // opened at 100, not 一字
    expect(seal?.sealAmount).toBeCloseTo(84205 * 100 * 104.17, 0);
    expect(renderSealTag(seal)).toContain("封");
    expect(renderSealTag(seal)).not.toContain("一字");
  });

  it("flags 一字板 when open=high=low=涨停价", () => {
    const seal = computeSealBoard({
      symbol: "600000",
      latestPrice: 11.0,
      previousClose: 10.0,
      openPrice: 11.0,
      highPrice: 11.0,
      lowPrice: 11.0,
      bid1Price: 11.0,
      bid1Volume: 500000,
      ask1Volume: 0,
    });
    expect(seal?.state).toBe("limit_up");
    expect(seal?.isOneWord).toBe(true);
    expect(renderSealTag(seal)).toBe("封5.5亿一字");
  });

  it("detects 跌停封板 with 封单 = 卖一量", () => {
    const seal = computeSealBoard({
      symbol: "600719",
      latestPrice: 9.0,
      previousClose: 10.0,
      bid1Volume: 0,
      ask1Price: 9.0,
      ask1Volume: 30000,
    });
    expect(seal?.state).toBe("limit_down");
    expect(seal?.sealVolumeLots).toBe(30000);
  });

  it("returns undefined when not at a limit price or prevClose is missing", () => {
    expect(computeSealBoard({ symbol: "600000", latestPrice: 10.5, previousClose: 10 })).toBeUndefined();
    expect(computeSealBoard({ symbol: "600000", latestPrice: 11 })).toBeUndefined();
    expect(renderSealTag(undefined)).toBe("");
  });
});
