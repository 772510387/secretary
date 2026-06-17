import { describe, expect, it } from "vitest";
import {
  cerebellumEventToNotificationEvent,
  createLivePaperSentinelTask,
} from "../../src/app/index.js";
import {
  indexSnapshotSchema,
  quoteSnapshotSchema,
  type IndexSnapshot,
  type QuoteSnapshot,
} from "../../src/domain/market/index.js";
import {
  positionSchema,
  type Position,
} from "../../src/domain/portfolio/index.js";
import type { CerebellumEvent } from "../../src/domain/cerebellum/index.js";
import type { NotificationEvent } from "../../src/domain/notification/index.js";

const now = "2026-06-17T02:00:00.000Z";

describe("createLivePaperSentinelTask", () => {
  it("emits a critical stop-loss event and marks positions to market", async () => {
    const captured: CerebellumEvent[][] = [];
    const persisted: Position[][] = [];

    const task = createLivePaperSentinelTask({
      getPositions: () => [makePosition({ costPrice: 74, latestPrice: 74 })],
      getQuotes: async () => [makeQuote({ latestPrice: 60 })],
      now: () => new Date(now),
      onEvents: (events) => {
        captured.push(events);
      },
      persistPositions: (positions) => {
        persisted.push(positions);
      },
    });

    await task();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toHaveLength(1);
    expect(captured[0]![0]).toMatchObject({
      eventType: "position_stop_loss",
      severity: "critical",
      symbol: "000636",
    });

    // Mark-to-market persisted the live price.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]![0]?.latestPrice).toBe(60);
  });

  it("skips quote fetch and reports zero when there are no positions", async () => {
    let quoteCalls = 0;
    const infos: Array<{ positionCount: number }> = [];

    const task = createLivePaperSentinelTask({
      getPositions: () => [],
      getQuotes: async () => {
        quoteCalls += 1;
        return [];
      },
      now: () => new Date(now),
      onEvents: (_events, info) => {
        infos.push(info);
      },
    });

    await task();

    expect(quoteCalls).toBe(0);
    expect(infos[0]?.positionCount).toBe(0);
  });

  it("alerts on a market index rapid drop via the systemic-risk radar", async () => {
    const notifications: NotificationEvent[][] = [];
    let call = 0;
    const task = createLivePaperSentinelTask({
      getPositions: () => [],
      getQuotes: async () => [],
      now: () => new Date(now),
      getIndexSnapshots: async () => {
        call += 1;
        return call === 1
          ? [makeIndex({ latestPrice: 4000, receivedAt: "2026-06-17T02:00:00.000Z" })]
          : [makeIndex({ latestPrice: 3900, receivedAt: "2026-06-17T02:00:30.000Z" })];
      },
      onIndexNotifications: (events) => {
        notifications.push(events);
      },
    });

    await task(); // primes the previous index snapshot
    await task(); // detects the -2.5% drop

    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toMatchObject({ severity: "critical" });
    expect(notifications[0]![0]!.summary).toMatch(/dropped/i);
  });

  it("scans a high-priority watchlist name and alerts on an intraday surge", async () => {
    const captured: CerebellumEvent[] = [];
    const task = createLivePaperSentinelTask({
      getPositions: () => [],
      getWatchlistEntries: () => [
        {
          symbol: "600519",
          market: "SSE",
          name: "贵州茅台",
          priority: "high",
          reason: "test",
          source: "test",
        },
      ],
      getQuotes: async () => [makeWatchQuote({ changePct: 0.05 })],
      now: () => new Date(now),
      onEvents: (events) => {
        captured.push(...events);
      },
    });

    await task();

    const surge = captured.find((event) => event.eventType === "watchlist_price_surge");
    expect(surge).toBeDefined();
    expect(surge?.symbol).toBe("600519");
    expect(surge?.severity).toBe("warning");
  });

  it("respects cooldown across consecutive ticks", async () => {
    const counts: number[] = [];
    const task = createLivePaperSentinelTask({
      getPositions: () => [makePosition({ costPrice: 74, latestPrice: 74 })],
      getQuotes: async () => [makeQuote({ latestPrice: 60 })],
      now: () => new Date(now),
      onEvents: (events) => {
        counts.push(events.length);
      },
    });

    await task();
    await task();

    expect(counts[0]).toBe(1); // first tick alerts
    expect(counts[1]).toBe(0); // second tick is within cooldown
  });
});

describe("cerebellumEventToNotificationEvent", () => {
  it("maps a stop-loss event to a critical symbol-targeted notification", async () => {
    const captured: CerebellumEvent[] = [];
    const task = createLivePaperSentinelTask({
      getPositions: () => [makePosition({ costPrice: 74, latestPrice: 74 })],
      getQuotes: async () => [makeQuote({ latestPrice: 60 })],
      now: () => new Date(now),
      onEvents: (events) => {
        captured.push(...events);
      },
    });

    await task();
    const notification = cerebellumEventToNotificationEvent(captured[0]!);

    expect(notification).toMatchObject({
      severity: "critical",
      source: { type: "cerebellum" },
      target: { type: "symbol", symbol: "000636" },
      channels: ["console", "file", "wechat"],
    });
    expect(notification.summary).toContain("000636");
  });
});

function makePosition(overrides: { costPrice?: number; latestPrice?: number } = {}): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: overrides.costPrice ?? 74,
    latestPrice: overrides.latestPrice ?? 74,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
  });
}

function makeIndex(overrides: { latestPrice: number; receivedAt: string }): IndexSnapshot {
  return indexSnapshotSchema.parse({
    indexId: "sse_composite",
    code: "000001",
    market: "SSE",
    name: "上证综指",
    provider: "tencent",
    latestPrice: overrides.latestPrice,
    changePct: 0,
    receivedAt: overrides.receivedAt,
    rawSymbol: "sh000001",
  });
}

function makeWatchQuote(overrides: { changePct: number }): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    symbol: "600519",
    market: "SSE",
    name: "贵州茅台",
    provider: "tencent",
    latestPrice: 1800,
    changePct: overrides.changePct,
    receivedAt: now,
    rawSymbol: "sh600519",
  });
}

function makeQuote(overrides: { latestPrice?: number } = {}): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    provider: "tencent",
    latestPrice: overrides.latestPrice ?? 74,
    changePct: 0,
    receivedAt: now,
    rawSymbol: "sz000636",
  });
}
