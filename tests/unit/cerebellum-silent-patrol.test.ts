import { describe, expect, it } from "vitest";
import {
  buildSilentPatrolTask,
  isSilentPatrolDue,
  SilentPatrolError,
} from "../../src/domain/cerebellum/index.js";
import {
  quoteSnapshotSchema,
  type QuoteSnapshot,
} from "../../src/domain/market/index.js";

const patrolTime = "2026-06-12T01:40:00.000Z";
const previousTime = "2026-06-12T01:39:10.000Z";

describe("Cerebellum silent patrol", () => {
  it("generates a silent 10-minute patrol task during Beijing trading hours", () => {
    const result = buildSilentPatrolTask({
      now: patrolTime,
      quotes: [],
      positions: [],
      previousQuotes: [],
    });

    expect(result.due).toBe(true);

    if (!result.due) {
      throw new Error("Expected silent patrol to be due");
    }

    expect(result.task).toMatchObject({
      taskType: "silent_patrol",
      patrolId: "silent-patrol-10m",
      intervalMinutes: 10,
      status: "silent",
      wakeBrain: false,
      scheduledAt: patrolTime,
      events: [],
      executionGuard: {
        toolExecutionAllowed: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
    });
    expect(result.task.beijingTime).toMatchObject({
      timezone: "Asia/Shanghai",
      date: "2026-06-12",
      time: "09:40:00",
    });
    expect(result.task.metadata).toMatchObject({
      silent: true,
      eventCount: 0,
      brainProviderCalled: false,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    });
  });

  it("skips outside trading sessions, non-list minutes, and weekends", () => {
    expect(
      buildSilentPatrolTask({
        now: "2026-06-12T03:45:00.000Z",
      }),
    ).toMatchObject({
      due: false,
      reason: "outside_session",
    });

    expect(
      buildSilentPatrolTask({
        now: "2026-06-12T01:50:00.000Z",
      }),
    ).toMatchObject({
      due: false,
      reason: "not_on_interval",
    });

    expect(
      buildSilentPatrolTask({
        now: "2026-06-13T01:40:00.000Z",
      }),
    ).toMatchObject({
      due: false,
      reason: "outside_session",
    });
    expect(isSilentPatrolDue(patrolTime)).toBe(true);
    expect(isSilentPatrolDue("2026-06-12T01:35:00.000Z")).toBe(true);
    expect(isSilentPatrolDue("2026-06-12T02:30:00.000Z")).toBe(false);
    expect(isSilentPatrolDue("2026-06-12T05:30:00.000Z")).toBe(false);
    expect(isSilentPatrolDue("2026-06-12T01:50:00.000Z")).toBe(false);
  });

  it("turns anomalies into pending events without allowing direct execution", () => {
    const result = buildSilentPatrolTask({
      now: patrolTime,
      quotes: [makeQuote({ latestPrice: 9.7, receivedAt: patrolTime })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
    });

    expect(result.due).toBe(true);

    if (!result.due) {
      throw new Error("Expected silent patrol to be due");
    }

    expect(result.task.status).toBe("pending_events");
    expect(result.task.wakeBrain).toBe(true);
    expect(result.task.events).toHaveLength(1);
    expect(result.task.events[0]).toMatchObject({
      eventType: "price_drop",
      source: "market_sentinel",
      cooldownKey: "price_drop:SZSE:000636",
      wakeBrain: true,
    });
    expect(result.task.metadata).toMatchObject({
      brainProviderCalled: false,
      brokerConnected: false,
      directExecutionAllowed: false,
      eventCount: 1,
      silent: false,
    });
    expect(result.task.executionGuard.brokerSubmissionAllowed).toBe(false);
    expect(result.nextCooldownState["price_drop:SZSE:000636"]).toBe(patrolTime);
  });

  it("deduplicates repeated anomalies and honors cooldown state", () => {
    const duplicateResult = buildSilentPatrolTask({
      now: patrolTime,
      quotes: [
        makeQuote({ latestPrice: 9.7, receivedAt: patrolTime }),
        makeQuote({ latestPrice: 9.7, receivedAt: patrolTime }),
      ],
      previousQuotes: [
        makeQuote({ latestPrice: 10, receivedAt: previousTime }),
        makeQuote({ latestPrice: 10, receivedAt: previousTime }),
      ],
      positions: [],
    });

    expect(duplicateResult.due).toBe(true);

    if (!duplicateResult.due) {
      throw new Error("Expected silent patrol to be due");
    }

    expect(duplicateResult.task.events).toHaveLength(1);

    const cooldownState = {
      "price_drop:SZSE:000636": "2026-06-12T01:39:00.000Z",
    };
    const coolingResult = buildSilentPatrolTask({
      now: patrolTime,
      quotes: [makeQuote({ latestPrice: 9.7, receivedAt: patrolTime })],
      previousQuotes: [makeQuote({ latestPrice: 10, receivedAt: previousTime })],
      positions: [],
      cooldownState,
    });

    expect(coolingResult.due).toBe(true);

    if (!coolingResult.due) {
      throw new Error("Expected silent patrol to be due");
    }

    expect(coolingResult.task.status).toBe("silent");
    expect(coolingResult.task.events).toEqual([]);
    expect(coolingResult.nextCooldownState).toEqual(cooldownState);
    expect(coolingResult.nextCooldownState).not.toBe(cooldownState);
  });

  it("redacts sensitive metadata and rejects invalid intervals", () => {
    const result = buildSilentPatrolTask({
      now: patrolTime,
      metadata: {
        apiKey: "sk-test-secret-123456",
        accountId: "paper-main",
        note: "token=abc123 keep summary",
      },
    });

    expect(result.due).toBe(true);

    if (!result.due) {
      throw new Error("Expected silent patrol to be due");
    }

    const serialized = JSON.stringify(result.task);
    expect(serialized).not.toContain("sk-test-secret-123456");
    expect(serialized).not.toContain("paper-main");
    expect(serialized).not.toContain("abc123");
    expect(result.task.metadata.apiKey).toBe("[redacted]");
    expect(result.task.metadata.accountId).toBe("[redacted]");

    expect(() =>
      buildSilentPatrolTask({
        now: patrolTime,
        options: {
          intervalMinutes: 0,
        },
      }),
    ).toThrow(SilentPatrolError);
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
    receivedAt: patrolTime,
    rawSymbol: "sz000636",
    ...overrides,
  });
}
