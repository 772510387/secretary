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
