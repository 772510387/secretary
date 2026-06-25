import { describe, expect, it } from "vitest";
import { AsOfMarketReader, KlineAsOfIndexSource } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  REPLAY_MARKET,
  REPLAY_SYMBOL,
  buildReplayBars,
  replayBarsBySymbol,
} from "../fixtures/replay/fixtures.js";

const symbols = [{ symbol: REPLAY_SYMBOL, market: REPLAY_MARKET, name: "平安银行" }];

function makeReader(): AsOfMarketReader {
  return new AsOfMarketReader({ historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()) });
}

describe("AsOfMarketReader (no look-ahead)", () => {
  it("post-close (inclusive) includes the same-day bar", async () => {
    const context = await makeReader().buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-06-19",
      inclusive: true,
    });

    expect(context.technicals).toHaveLength(1);
    expect(context.technicals[0]!.asOfDate).toBe("2026-06-19");
    expect(context.priceSources[REPLAY_SYMBOL]!.tradeDate).toBe("2026-06-19");
    expect(context.pricesAvailable).toBe(true);
  });

  it("pre-close (exclusive) values at the prior trading day", async () => {
    const context = await makeReader().buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-06-19",
      inclusive: false,
    });

    expect(context.technicals[0]!.asOfDate).toBe("2026-06-18");
    expect(context.priceSources[REPLAY_SYMBOL]!.tradeDate).toBe("2026-06-18");
  });

  it("never lets a future bar affect the as-of price", async () => {
    const context = await makeReader().buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-06-19",
      inclusive: true,
    });
    const fridayClose = buildReplayBars().find((bar) => bar.tradeDate === "2026-06-19")!.close;

    expect(context.prices[REPLAY_SYMBOL]).toBe(fridayClose);
    // sanity: there ARE later bars in the fixture that must not have been used
    expect(buildReplayBars().some((bar) => bar.tradeDate > "2026-06-19")).toBe(true);
  });

  it("degrades (does not throw) a symbol with no bar on/before asOfDate", async () => {
    const context = await makeReader().buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-05-01", // before the first fixture bar
      inclusive: true,
    });

    expect(context.technicals).toHaveLength(0);
    expect(context.degraded).toBe(true);
    expect(context.pricesAvailable).toBe(false);
    expect(context.degradedReasons[0]).toContain(REPLAY_SYMBOL);
  });

  it("computes MA5 from exactly the as-of window (no future inflation)", async () => {
    const context = await makeReader().buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-06-19",
      inclusive: true,
      count: 5,
    });
    const closes = buildReplayBars()
      .filter((bar) => bar.tradeDate <= "2026-06-19")
      .slice(-5)
      .map((bar) => bar.close);
    const expectedMa5 = Math.round((closes.reduce((sum, value) => sum + value, 0) / 5) * 10_000) / 10_000;

    expect(context.technicals[0]!.ma5).toBe(expectedMa5);
  });

  it("reads index context from an as-of source without using future bars", async () => {
    const reader = new AsOfMarketReader({
      historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
      indexSource: new KlineAsOfIndexSource({
        historyProvider: new FixtureHistoryProvider({
          "000001": buildReplayBars("000001", "SSE"),
        }),
      }),
    });

    const context = await reader.buildAsOfMarketContext({
      symbols,
      asOfDate: "2026-06-19",
      inclusive: false,
    });

    expect(context.indices).toHaveLength(1);
    expect(context.indices[0]).toMatchObject({
      indexId: "sse_composite",
      name: "上证综指",
      asOfDate: "2026-06-18",
    });
  });
});
