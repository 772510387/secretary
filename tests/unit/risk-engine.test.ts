import { describe, expect, it } from "vitest";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import {
  RiskEngine,
  RiskEngineError,
  calculateDailyLossRatio,
  checkRisk,
} from "../../src/domain/risk/index.js";
import {
  createOrderFromIntent,
  tradeIntentSchema,
  type Order,
  type TradeIntent,
} from "../../src/domain/trading/index.js";

const now = "2026-06-12T01:30:00.000Z";

describe("RiskEngine", () => {
  it("passes when no risk rule is triggered", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 80 }),
    });

    expect(result).toEqual({
      decision: "passed",
      severity: "info",
      violations: [],
      blockingViolations: [],
      requiresManualConfirmation: false,
    });
  });

  it("rejects a buy that would exceed the 40% single-position limit", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 90 }),
    });

    expect(result.decision).toBe("rejected");
    expect(result.severity).toBe("critical");
    expect(result.requiresManualConfirmation).toBe(true);
    expect(result.blockingViolations).toMatchObject([
      {
        code: "position_limit_exceeded",
        blocking: true,
        symbol: "000636",
        threshold: 0.4,
        value: 0.45,
      },
    ]);
  });

  it("allows a buy exactly at the 40% single-position limit", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 80 }),
    });

    expect(result.decision).toBe("passed");
  });

  it("checks projected exposure for an existing position", () => {
    const result = checkRisk({
      account: makeAccount({
        cash: {
          available: 12000,
          frozen: 0,
        },
      }),
      positions: [
        makePosition({
          quantity: 100,
          costPrice: 70,
          latestPrice: 70,
        }),
      ],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 80 }),
    });

    expect(result).toMatchObject({
      decision: "rejected",
      blockingViolations: [
        {
          code: "position_limit_exceeded",
          value: 0.8,
        },
      ],
    });
  });

  it("emits a critical hard-stop warning at an 8% loss without blocking by itself", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [
        makePosition({
          quantity: 100,
          costPrice: 10,
          latestPrice: 9.2,
        }),
      ],
    });

    expect(result.decision).toBe("warning");
    expect(result.severity).toBe("critical");
    expect(result.requiresManualConfirmation).toBe(true);
    expect(result.blockingViolations).toEqual([]);
    expect(result.violations).toMatchObject([
      {
        code: "hard_stop_loss",
        symbol: "000636",
        threshold: 0.08,
        value: 0.08,
        blocking: false,
      },
    ]);
  });

  it("uses external prices for hard-stop checks", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [
        makePosition({
          quantity: 100,
          costPrice: 10,
          latestPrice: 10,
        }),
      ],
      options: {
        prices: {
          "000636": 9.1,
        },
      },
    });

    expect(result.violations[0]).toMatchObject({
      code: "hard_stop_loss",
      value: 0.09,
    });
  });

  it("rejects new buys when daily loss reaches the configured limit", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 10 }),
      dailyLoss: {
        baselineAssets: 20000,
        currentAssets: 19400,
      },
    });

    expect(result).toMatchObject({
      decision: "rejected",
      severity: "critical",
      blockingViolations: [
        {
          code: "daily_loss_limit_exceeded",
          threshold: 0.03,
          value: 0.03,
        },
      ],
    });
  });

  it("calculates daily loss ratio from pnl values", () => {
    expect(
      calculateDailyLossRatio({
        baselineAssets: 20000,
        realizedPnl: -200,
        unrealizedPnl: -300,
      }),
    ).toBe(0.025);
    expect(calculateDailyLossRatio({ lossRatio: 0.031234 })).toBe(0.031234);
    expect(calculateDailyLossRatio({ baselineAssets: 20000, totalPnl: 100 })).toBe(0);
  });

  it("rejects buys when no-buy state is active", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 10 }),
      runtimeState: {
        noBuy: true,
        noBuyReason: "manual risk lock",
      },
    });

    expect(result).toMatchObject({
      decision: "rejected",
      blockingViolations: [
        {
          code: "no_buy_active",
          message: "manual risk lock",
        },
      ],
    });
  });

  it("rejects buys when circuit breaker is active", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 10 }),
      runtimeState: {
        circuitBreaker: true,
        circuitBreakerReason: "index flash crash",
      },
    });

    expect(result).toMatchObject({
      decision: "rejected",
      blockingViolations: [
        {
          code: "circuit_breaker_active",
          message: "index flash crash",
        },
      ],
    });
  });

  it("does not block sells because of no-buy or circuit-breaker state", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [
        makePosition({
          quantity: 100,
          availableQuantity: 100,
        }),
      ],
      order: makeOrder({ side: "SELL", quantity: 100, limitPrice: 10 }),
      runtimeState: {
        noBuy: true,
        circuitBreaker: true,
      },
    });

    expect(result.decision).toBe("passed");
  });

  it("combines blocking and non-blocking violations in one result", () => {
    const result = checkRisk({
      account: makeAccount(),
      positions: [
        makePosition({
          quantity: 100,
          costPrice: 10,
          latestPrice: 9.1,
        }),
      ],
      order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 90 }),
    });

    expect(result.decision).toBe("rejected");
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "hard_stop_loss",
      "position_limit_exceeded",
    ]);
    expect(result.blockingViolations.map((violation) => violation.code)).toEqual([
      "position_limit_exceeded",
    ]);
  });

  it("throws on invalid risk option ratios", () => {
    const engine = new RiskEngine();

    expect(() =>
      engine.check({
        account: makeAccount(),
        positions: [],
        options: {
          maxSinglePositionRatio: 1.2,
        },
      }),
    ).toThrow(RiskEngineError);
  });
});

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return tradeIntentSchema.parse({
    intentId: "intent-risk-0001",
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    side: "BUY",
    quantity: 100,
    limitPrice: 10,
    currency: "CNY",
    source: "test",
    createdAt: now,
    ...overrides,
  });
}

function makeOrder(overrides: Partial<TradeIntent> = {}): Order {
  return createOrderFromIntent({
    orderId: "order-risk-0001",
    intent: makeIntent(overrides),
    now,
  });
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: 20000,
      frozen: 0,
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
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
    openedAt: now,
    updatedAt: now,
    ...overrides,
  });
}
