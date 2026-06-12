import { describe, expect, it } from "vitest";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import {
  PolicyEngine,
  PolicyEngineError,
  checkOrderPolicy,
  isMainBoardSymbol,
} from "../../src/domain/risk/index.js";
import {
  createOrderFromIntent,
  tradeIntentSchema,
  type Order,
  type TradeIntent,
} from "../../src/domain/trading/index.js";

const now = "2026-06-12T01:30:00.000Z";

describe("PolicyEngine", () => {
  it("passes a main-board buy with enough cash and 100-share lot", () => {
    const result = checkOrderPolicy({
      order: makeOrder({ side: "BUY", symbol: "000636", market: "SZSE", quantity: 100 }),
      account: makeAccount({ cash: { available: 20000, frozen: 0 } }),
      positions: [],
    });

    expect(result).toEqual({ decision: "passed" });
  });

  it("rejects non-main-board symbols by default", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", symbol: "688001", market: "SSE", quantity: 100 }),
        account: makeAccount(),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "non_main_board" },
    });

    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", symbol: "300001", market: "SZSE", quantity: 100 }),
        account: makeAccount(),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "non_main_board" },
    });
  });

  it("allows non-main-board symbols when mainBoardOnly is disabled", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", symbol: "688001", market: "SSE", quantity: 100 }),
        account: makeAccount(),
        positions: [],
        options: { mainBoardOnly: false },
      }),
    ).toEqual({ decision: "passed" });
  });

  it("rejects buy quantities that are not multiples of the lot size", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", quantity: 50 }),
        account: makeAccount(),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "invalid_lot_size" },
    });

    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", quantity: 150 }),
        account: makeAccount(),
        positions: [],
        options: { lotSize: 50 },
      }),
    ).toEqual({ decision: "passed" });
  });

  it("rejects buys when available cash is insufficient including estimated costs", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "BUY", quantity: 100, limitPrice: 10 }),
        account: makeAccount({ cash: { available: 1000, frozen: 0 } }),
        positions: [],
        options: { estimatedFees: 1 },
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "insufficient_cash" },
    });
  });

  it("rejects sells when no matching position exists", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "SELL", quantity: 100 }),
        account: makeAccount(),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "position_not_found" },
    });
  });

  it("rejects sells blocked by T+1 available quantity", () => {
    const position = makePosition({
      quantity: 100,
      availableQuantity: 100,
      todayBuyQuantity: 100,
      frozenQuantity: 0,
    });

    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "SELL", quantity: 100 }),
        account: makeAccount(),
        positions: [position],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "insufficient_sellable_quantity" },
    });

    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "SELL", quantity: 100 }),
        account: makeAccount(),
        positions: [position],
        options: { t1Enabled: false },
      }),
    ).toEqual({ decision: "passed" });
  });

  it("allows selling odd lots while respecting sellable quantity", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ side: "SELL", quantity: 50 }),
        account: makeAccount(),
        positions: [makePosition({ quantity: 100, availableQuantity: 100 })],
      }),
    ).toEqual({ decision: "passed" });
  });

  it("rejects account mismatch and inactive accounts", () => {
    expect(
      checkOrderPolicy({
        order: makeOrder({ accountId: "paper-other" }),
        account: makeAccount({ accountId: "paper-main" }),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "account_mismatch" },
    });

    expect(
      checkOrderPolicy({
        order: makeOrder(),
        account: makeAccount({ status: "suspended" }),
        positions: [],
      }),
    ).toMatchObject({
      decision: "rejected",
      reason: { code: "account_not_active" },
    });
  });

  it("classifies main-board symbols conservatively", () => {
    expect(isMainBoardSymbol("600000", "SSE")).toBe(true);
    expect(isMainBoardSymbol("601187", "SSE")).toBe(true);
    expect(isMainBoardSymbol("603000", "SSE")).toBe(true);
    expect(isMainBoardSymbol("605000", "SSE")).toBe(true);
    expect(isMainBoardSymbol("688001", "SSE")).toBe(false);
    expect(isMainBoardSymbol("000636", "SZSE")).toBe(true);
    expect(isMainBoardSymbol("001000", "SZSE")).toBe(true);
    expect(isMainBoardSymbol("002001", "SZSE")).toBe(true);
    expect(isMainBoardSymbol("003001", "SZSE")).toBe(true);
    expect(isMainBoardSymbol("300001", "SZSE")).toBe(false);
  });

  it("rejects invalid lot-size configuration", () => {
    const engine = new PolicyEngine();

    expect(() =>
      engine.checkOrder({
        order: makeOrder(),
        account: makeAccount(),
        positions: [],
        options: { lotSize: 0 },
      }),
    ).toThrow(PolicyEngineError);
  });
});

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return tradeIntentSchema.parse({
    intentId: "intent-policy-0001",
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
    orderId: "order-policy-0001",
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

