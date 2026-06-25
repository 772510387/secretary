import { describe, expect, it } from "vitest";
import {
  buildIntradayCheckpoint,
  renderIntradayTimeline,
  type IntradayCheckpoint,
} from "../../src/domain/market/index.js";

function checkpoint(time: string, occurredAt: string, overrides: Partial<IntradayCheckpoint> = {}): IntradayCheckpoint {
  return buildIntradayCheckpoint({
    time,
    occurredAt,
    alarmType: overrides.alarmType ?? "morning_review",
    indices: overrides.indices ?? [{ name: "上证综合指数", changePct: 0.3 }],
    themeHeat: { limitUpCount: 20, limitDownCount: 3, heatScore: 60 },
  });
}

describe("buildIntradayCheckpoint", () => {
  it("captures indices + sentiment, and nulls heat when the heat snapshot is degraded", () => {
    const cp = buildIntradayCheckpoint({
      time: "10:00",
      occurredAt: "2026-06-25T02:00:00.000Z",
      alarmType: "morning_review",
      indices: [{ name: "上证综合指数", changePct: 0.5 }],
      holdings: [{ symbol: "002475", name: "立讯精密", price: 74.4 }],
      themeHeat: { limitUpCount: 45, limitDownCount: 2, heatScore: 72, degraded: true },
    });

    expect(cp.indices[0]).toEqual({ name: "上证综合指数", changePct: 0.5 });
    expect(cp.holdings[0]).toEqual({ symbol: "002475", name: "立讯精密", price: 74.4 });
    // degraded heat → metrics nulled (honest, not fabricated)
    expect(cp.limitUpCount).toBeNull();
    expect(cp.heatScore).toBeNull();
  });
});

describe("renderIntradayTimeline", () => {
  it("returns empty for the first node of the day (nothing to compare)", () => {
    expect(renderIntradayTimeline([])).toBe("");
    expect(renderIntradayTimeline([checkpoint("09:15", "2026-06-25T01:15:00.000Z")])).toBe("");
  });

  it("renders a multi-node timeline marking the latest as 本次", () => {
    const timeline = [
      checkpoint("09:15", "2026-06-25T01:15:00.000Z", { indices: [{ name: "上证综合指数", changePct: -0.5 }] }),
      checkpoint("10:00", "2026-06-25T02:00:00.000Z", { indices: [{ name: "上证综合指数", changePct: 0.8 }] }),
    ];
    const rendered = renderIntradayTimeline(timeline);

    expect(rendered).toContain("今日第 2 次观察");
    expect(rendered).toContain("09:15");
    expect(rendered).toContain("10:00(本次)");
    expect(rendered).toContain("上证-0.50%");
    expect(rendered).toContain("上证+0.80%");
    expect(rendered).toContain("涨停20家");
    expect(rendered).toContain("对比上次→本次");
  });
});
