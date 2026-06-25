import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAsOfBridgeContext, prefetchAsOfIndexSource } from "../../scripts/dev/build-context.js";
import { KlineAsOfIndexSource } from "../../src/app/index.js";
import { appConfigSchema } from "../../src/config/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  buildReplayBars,
  REPLAY_SYMBOL,
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

function provider(): FixtureHistoryProvider {
  return new FixtureHistoryProvider(replayBarsBySymbol());
}

describe("buildAsOfBridgeContext (faithful replay, no look-ahead)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("post-close: includes the same day; omits indices without an as-of source + web search", async () => {
    const context = await buildAsOfBridgeContext({
      account: replayAccount(),
      positions: replayPositions(),
      asOfDate: "2026-06-19",
      sameDayBarIncluded: true,
      historyProvider: provider(),
    });

    expect(context.account?.accountId).toBe("paper-replay");
    expect(context.technicals![0]!.asOfDate).toBe("2026-06-19");
    expect(context.prices![REPLAY_SYMBOL]).toBeGreaterThan(0);
    // No as-of source for these → omitted (including live ones would be look-ahead).
    expect(context.indices).toEqual([]);
    expect(context.webSearch).toBeUndefined();
  });

  it("includes historical indices when an as-of index source is provided", async () => {
    const context = await buildAsOfBridgeContext({
      account: replayAccount(),
      positions: replayPositions(),
      asOfDate: "2026-06-19",
      sameDayBarIncluded: true,
      historyProvider: provider(),
      indexSource: new KlineAsOfIndexSource({
        historyProvider: new FixtureHistoryProvider({
          "000001": buildReplayBars("000001", "SSE"),
        }),
      }),
    });

    expect(context.indices).toHaveLength(1);
    expect(context.indices![0]).toMatchObject({
      name: "上证综指",
      asOfDate: "2026-06-19",
    });
    expect(context.dataHealth).toMatchObject({
      indicesCount: 1,
      degraded: false,
    });
  });

  it("prefetches all four as-of indices without treating index codes as stock symbols", async () => {
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const raw = decodeURIComponent(String(url)).match(/param=(sh|sz)\d{6}/)?.[0]?.slice("param=".length);
      if (!raw) {
        return { ok: true, text: async () => JSON.stringify({ data: {} }) };
      }

      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            data: {
              [raw]: {
                qfqday: [
                  ["2026-06-18", "10", "10", "10.1", "9.9", "1000", "10000"],
                  ["2026-06-19", "10", "11", "11.1", "9.9", "2000", "22000"],
                ],
              },
            },
          }),
      };
    });

    const source = await prefetchAsOfIndexSource(appConfigSchema.parse({}), "2026-06-19");
    const indices = await source.getIndicesAsOf("2026-06-19", true);

    expect(indices.map((index) => index.indexId).sort()).toEqual([
      "chinext",
      "sse_composite",
      "star50",
      "szse_component",
    ]);
    expect(indices.every((index) => index.asOfDate === "2026-06-19")).toBe(true);
  });

  it("pre-close: values at the prior trading day (no peeking into the day)", async () => {
    const context = await buildAsOfBridgeContext({
      account: replayAccount(),
      positions: replayPositions(),
      asOfDate: "2026-06-19",
      sameDayBarIncluded: false,
      historyProvider: provider(),
    });
    expect(context.technicals![0]!.asOfDate).toBe("2026-06-18");
  });

  it("never surfaces a bar dated after asOfDate", async () => {
    const context = await buildAsOfBridgeContext({
      account: replayAccount(),
      positions: replayPositions(),
      asOfDate: "2026-06-17",
      sameDayBarIncluded: true,
      historyProvider: provider(),
    });
    expect(context.technicals!.every((technical) => technical.asOfDate <= "2026-06-17")).toBe(true);
    // the fixture has bars after 06-17 that must NOT leak in
    expect(context.technicals![0]!.asOfDate).toBe("2026-06-17");
  });

  it("uses ranked watchlist symbols when the replay account has no positions", async () => {
    const watchSymbol = "600000";
    const context = await buildAsOfBridgeContext({
      account: replayAccount(),
      positions: [],
      watchlist: [{ symbol: watchSymbol, market: "SSE", name: "浦发银行", rank: 1 }],
      asOfDate: "2026-06-19",
      sameDayBarIncluded: true,
      historyProvider: new FixtureHistoryProvider({
        [watchSymbol]: buildReplayBars(watchSymbol, "SSE"),
      }),
    });

    expect(context.positions).toEqual([]);
    expect(context.watchlist).toHaveLength(1);
    expect(context.prices![watchSymbol]).toBeGreaterThan(0);
    expect(context.technicals![0]).toMatchObject({
      symbol: watchSymbol,
      asOfDate: "2026-06-19",
    });
    expect(context.dataHealth).toMatchObject({
      pricedSymbols: 1,
      watchlistCount: 1,
    });
  });
});
