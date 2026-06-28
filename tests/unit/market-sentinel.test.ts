import { describe, expect, it } from "vitest";
import {
  checkMarketSentinel,
  MarketSentinelError,
} from "../../src/domain/cerebellum/index.js";
import {
  quoteSnapshotSchema,
  type QuoteSnapshot,
} from "../../src/domain/market/index.js";
import {
  positionSchema,
  type Position,
} from "../../src/domain/portfolio/index.js";

const now = "2026-06-12T01:31:00.000Z";
const previousTime = "2026-06-12T01:30:10.000Z";

describe("MarketSentinel single check", () => {
  it("emits a warning event for a one-minute rapid surge", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 10.25, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "price_surge",
      severity: "warning",
      symbol: "000636",
      currentPrice: 10.25,
      previousPrice: 10,
      changePct: 0.025,
      threshold: 0.02,
      wakeBrain: true,
      source: "market_sentinel",
    });
    expect(result.nextCooldownState["price_surge:SZSE:000636"]).toBe(now);
  });

  it("emits a warning event for a one-minute rapid drop", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.75, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "price_drop",
      severity: "warning",
      changePct: -0.025,
    });
  });

  it("does not emit rapid-move events outside the configured window", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 10.5, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: "2026-06-12T01:20:00.000Z" })],
      positions: [],
    });

    expect(result.events).toEqual([]);
  });

  it("emits the ±5% absolute-move redline only when opted in", () => {
    // +6% on the day (latestPrice 10.6 vs previousClose 10), no previousQuotes → no rapid-move.
    const quote = makeQuote({ latestPrice: 10.6, receivedAt: now });

    // Default (no option): the absolute redline is OFF → no event.
    expect(checkMarketSentinel({ now, quotes: [quote], positions: [] }).events).toEqual([]);

    // Opt-in (production daemon sets this): fires a single price_surge at the ±5% threshold.
    const result = checkMarketSentinel({
      now,
      quotes: [quote],
      positions: [],
      options: { absoluteMoveThreshold: 0.05 },
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "price_surge",
      threshold: 0.05,
      cooldownKey: "price_surge:SZSE:000636",
    });
  });

  it("emits a previous-high breakout redline only when opted in", () => {
    const quote = makeQuote({ latestPrice: 10.25, highPrice: 10.25, receivedAt: now });
    const previous = makeQuote({
      latestPrice: 10.15,
      highPrice: 10.2,
      receivedAt: previousTime,
    });

    expect(
      checkMarketSentinel({
        now,
        quotes: [quote],
        previousQuotes: [previous],
        positions: [],
      }).events,
    ).toEqual([]);

    const result = checkMarketSentinel({
      now,
      quotes: [quote],
      previousQuotes: [previous],
      positions: [],
      options: { previousHighBreakoutThreshold: 0 },
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "previous_high_breakout",
      severity: "warning",
      currentPrice: 10.25,
      previousPrice: 10.2,
      cooldownKey: "previous_high_breakout:SZSE:000636",
      wakeBrain: true,
    });
  });

  it("emits a critical stop-loss event for positions down 8% from cost", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.2, receivedAt: now })],
      positions: [
        makePosition({
          costPrice: 10,
          latestPrice: 10,
        }),
      ],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "position_stop_loss",
      severity: "critical",
      currentPrice: 9.2,
      previousPrice: 10,
      changePct: -0.08,
      threshold: 0.08,
      cooldownKey: "position_stop_loss:SZSE:000636",
    });
  });

  it("can use the position latest price for stop-loss when no quote is present", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [],
      positions: [makePosition({ costPrice: 10, latestPrice: 9.1 })],
    });

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: "position_stop_loss",
      currentPrice: 9.1,
      changePct: -0.09,
    });
  });

  it("applies cooldown per event type and symbol without mutating input state", () => {
    const cooldownState = {
      "price_drop:SZSE:000636": "2026-06-12T01:30:30.000Z",
    };

    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.75, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
      cooldownState,
    });

    expect(result.events).toEqual([]);
    expect(result.nextCooldownState).toEqual(cooldownState);
    expect(result.nextCooldownState).not.toBe(cooldownState);
  });

  it("emits again after cooldown expires", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.75, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
      cooldownState: {
        "price_drop:SZSE:000636": "2026-06-12T01:10:00.000Z",
      },
    });

    expect(result.events).toHaveLength(1);
    expect(result.nextCooldownState["price_drop:SZSE:000636"]).toBe(now);
  });

  it("emits independent rapid-move and stop-loss events for the same symbol", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.1, receivedAt: now })],
      previousQuotes: [makeQuote({ latestPrice: 9.35, receivedAt: previousTime })],
      positions: [makePosition({ costPrice: 10, latestPrice: 9.35 })],
    });

    expect(result.events.map((event) => event.eventType)).toEqual([
      "price_drop",
      "position_stop_loss",
    ]);
  });

  it("scans high-priority watchlist entries for daily move and observe-price events", () => {
    const result = checkMarketSentinel({
      now,
      quotes: [
        makeQuote({
          latestPrice: 10.05,
          changePct: 0.035,
          receivedAt: now,
        }),
      ],
      positions: [],
      watchlistEntries: [
        {
          symbol: "000636",
          market: "SZSE",
          name: "Mock Watch",
          priority: "high",
          reason: "Manual seed for today's focus.",
          source: "manual_seed",
          updatedAt: now,
          observePrice: 10,
        },
      ],
    });

    expect(result.events.map((event) => event.eventType)).toEqual([
      "watchlist_price_surge",
      "watchlist_observe_price_near",
    ]);
    expect(result.events[0]).toMatchObject({
      severity: "warning",
      currentPrice: 10.05,
      changePct: 0.035,
      threshold: 0.03,
      wakeBrain: true,
      cooldownKey: "watchlist_price_surge:SZSE:000636",
    });
    expect(result.events[1]).toMatchObject({
      severity: "watch",
      currentPrice: 10.05,
      previousPrice: 10,
      changePct: 0.005,
      threshold: 0.01,
      cooldownKey: "watchlist_observe_price_near:SZSE:000636",
    });
    expect(result.auditEvents).toHaveLength(2);
    expect(result.auditEvents[0]).toMatchObject({
      action: "validate",
      result: "success",
      metadata: {
        eventType: "watchlist_price_surge",
        symbol: "000636",
        brokerConnected: false,
        directExecutionAllowed: false,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(result.auditEvents)).not.toContain("Manual seed for today's focus.");
  });

  it("ignores non-high watchlist entries by default and honors watchlist cooldown", () => {
    const nonHigh = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.6, changePct: -0.04, receivedAt: now })],
      positions: [],
      watchlistEntries: [
        {
          symbol: "000636",
          market: "SZSE",
          name: "Mock Watch",
          priority: "medium",
          reason: "Manual import.",
          source: "manual_import",
          updatedAt: now,
        },
      ],
    });

    expect(nonHigh.events).toEqual([]);

    const cooling = checkMarketSentinel({
      now,
      quotes: [makeQuote({ latestPrice: 9.6, changePct: -0.04, receivedAt: now })],
      positions: [],
      watchlistEntries: [
        {
          symbol: "000636",
          market: "SZSE",
          name: "Mock Watch",
          priority: "high",
          reason: "Manual import.",
          source: "manual_import",
          updatedAt: now,
        },
      ],
      cooldownState: {
        "watchlist_price_drop:SZSE:000636": "2026-06-12T01:30:30.000Z",
      },
    });

    expect(cooling.events).toEqual([]);
    expect(cooling.auditEvents).toEqual([]);
  });

  it("throws for invalid threshold configuration", () => {
    expect(() =>
      checkMarketSentinel({
        now,
        quotes: [],
        positions: [],
        options: {
          rapidMoveThreshold: 1.1,
        },
      }),
    ).toThrow(MarketSentinelError);
  });

  it("throws for invalid check time", () => {
    expect(() =>
      checkMarketSentinel({
        now: new Date("invalid"),
        quotes: [],
        positions: [],
      }),
    ).toThrow(MarketSentinelError);
  });
});

function makeQuote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    provider: "tencent",
    latestPrice: 10,
    previousClose: 10,
    openPrice: 10,
    changeAmount: 0,
    changePct: 0,
    receivedAt: now,
    rawSymbol: "sz000636",
    ...overrides,
  });
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 10,
    currency: "CNY",
    openedAt: "2026-06-12T01:00:00.000Z",
    updatedAt: now,
    ...overrides,
  });
}
