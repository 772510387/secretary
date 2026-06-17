import { describe, expect, it } from "vitest";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import {
  createExecutionReport,
  createOrderFromIntent,
  reconcilePortfolioSnapshots,
  tradeIntentSchema,
  type ExecutionReport,
  type Order,
} from "../../src/domain/trading/index.js";

const now = "2026-06-16T01:30:00.000Z";
const accountId = "paper-main";

describe("ReconciliationResult", () => {
  it("returns matched when local and broker snapshots are identical", () => {
    const snapshot = makeSnapshot();
    const result = reconcilePortfolioSnapshots({
      reconciliationId: "recon-matched",
      accountId,
      checkedAt: now,
      local: snapshot,
      broker: snapshot,
      metadata: {
        source: "unit-test",
      },
    });

    expect(result).toMatchObject({
      reconciliationId: "recon-matched",
      status: "matched",
      requiresManualReview: false,
      cash: {
        status: "matched",
        localAvailable: 10000,
        brokerAvailable: 10000,
        localFrozen: 500,
        brokerFrozen: 500,
      },
      summary: {
        issueCount: 0,
        criticalIssueCount: 0,
      },
    });
    expect(result.positions[0]).toMatchObject({
      status: "matched",
      localSellableQuantity: 100,
      brokerSellableQuantity: 100,
      localFrozenQuantity: 0,
      brokerFrozenQuantity: 0,
    });
    expect(result.intentMappings[0]).toMatchObject({
      intentId: "intent-000636",
      status: "matched",
      localOrderIds: ["order-000636"],
      brokerOrderIds: ["order-000636"],
    });
  });

  it("detects cash, sellable, frozen, order, and execution mismatches", () => {
    const local = makeSnapshot();
    const broker = makeSnapshot({
      account: makeAccount({ available: 9900, frozen: 600 }),
      positions: [
        makePosition({
          availableQuantity: 50,
          frozenQuantity: 50,
        }),
      ],
      orders: [
        {
          ...local.orders![0]!,
          status: "cancelled",
        } as Order,
      ],
      executions: [
        {
          ...local.executions![0]!,
          quantity: 50,
        } as ExecutionReport,
      ],
    });
    const result = reconcilePortfolioSnapshots({
      reconciliationId: "recon-mismatch",
      accountId,
      checkedAt: now,
      local,
      broker,
    });

    expect(result.status).toBe("mismatch");
    expect(result.requiresManualReview).toBe(true);
    expect(result.issues.map((issue) => `${issue.scope}:${issue.field ?? issue.ref}`)).toEqual([
      "cash:available",
      "cash:frozen",
      "sellable:sellableQuantity",
      "frozen:frozenQuantity",
      "order:status",
      "execution:quantity",
    ]);
    expect(result.summary.criticalIssueCount).toBe(6);
  });

  it("marks missing broker orders or executions as unknown", () => {
    const local = makeSnapshot();
    const result = reconcilePortfolioSnapshots({
      reconciliationId: "recon-unknown",
      accountId,
      checkedAt: now,
      local,
      broker: {
        account: local.account,
        positions: local.positions,
        orders: [],
        executions: [],
      },
    });

    expect(result.status).toBe("unknown");
    expect(result.orders[0]).toMatchObject({
      orderId: "order-000636",
      status: "unknown",
    });
    expect(result.executions[0]).toMatchObject({
      executionId: "execution-000636",
      status: "unknown",
    });
    expect(result.issues.map((issue) => issue.scope)).toContain("intent_mapping");
  });

  it("requires manual review when one intent maps to duplicate broker orders", () => {
    const local = makeSnapshot({ executions: [] });
    const broker = makeSnapshot({
      executions: [],
      orders: [
        local.orders![0]!,
        {
          ...local.orders![0]!,
          orderId: "order-000636-duplicate",
        },
      ],
    });
    const result = reconcilePortfolioSnapshots({
      reconciliationId: "recon-duplicate-intent",
      accountId,
      checkedAt: now,
      local,
      broker,
    });

    expect(result.status).toBe("needs_manual_review");
    expect(result.intentMappings[0]).toMatchObject({
      intentId: "intent-000636",
      status: "needs_manual_review",
      localOrderIds: ["order-000636"],
      brokerOrderIds: ["order-000636", "order-000636-duplicate"],
    });
    const intentMappingIssue = result.issues.find((issue) => issue.scope === "intent_mapping");
    expect(intentMappingIssue).toMatchObject({
      scope: "intent_mapping",
      status: "needs_manual_review",
      severity: "critical",
    });
  });
});

function makeSnapshot(
  overrides: Partial<{
    account: ReturnType<typeof makeAccount>;
    positions: ReturnType<typeof makePosition>[];
    orders: Order[];
    executions: ExecutionReport[];
  }> = {},
) {
  const account = overrides.account ?? makeAccount();
  const positions = overrides.positions ?? [makePosition()];
  const order = createOrderFromIntent({
    orderId: "order-000636",
    intent: makeIntent(),
    now,
  });
  const orders = overrides.orders ?? [
    {
      ...order,
      status: "filled",
      updatedAt: now,
    } as Order,
  ];
  const executions = overrides.executions ?? [
    createExecutionReport({
      executionId: "execution-000636",
      tradeId: "trade-000636",
      order: orders[0]!,
      executedAt: now,
    }),
  ];

  return {
    account,
    positions,
    orders,
    executions,
  };
}

function makeAccount(overrides: { available?: number; frozen?: number } = {}) {
  return accountSchema.parse({
    accountId,
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 10000,
    cash: {
      available: overrides.available ?? 10000,
      frozen: overrides.frozen ?? 500,
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function makePosition(overrides: Partial<Parameters<typeof positionSchema.parse>[0]> = {}) {
  return positionSchema.parse({
    accountId,
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
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

function makeIntent() {
  return tradeIntentSchema.parse({
    intentId: "intent-000636",
    accountId,
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    side: "BUY",
    quantity: 100,
    limitPrice: 10,
    currency: "CNY",
    source: "test",
    createdAt: now,
  });
}
