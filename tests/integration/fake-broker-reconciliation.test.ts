import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import {
  createOrderFromIntent,
  reconcilePortfolioSnapshots,
  tradeIntentSchema,
} from "../../src/domain/trading/index.js";
import {
  FakeBrokerReconciliationService,
  FakeReadOnlyBroker,
  applyReconciliationFailureDowngrade,
  clearReconciliationFailureDowngrade,
  createBrokerReconciliationAuditPath,
} from "../../src/infrastructure/broker/index.js";
import {
  LiveTradingSafetyStore,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";
const accountId = "live-account-001";

describe("FakeBrokerReconciliationService", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("writes critical audit and returns a critical notification on mismatch", async () => {
    const memoryDir = createTempMemoryDir();
    const local = makeSnapshot({
      account: makeAccount({ available: 12000, frozen: 0 }),
    });
    const broker = new FakeReadOnlyBroker({
      memoryDir,
      account: makeAccount({ available: 11900, frozen: 100 }),
      positions: local.positions,
      orders: local.orders,
      executions: local.executions,
      now: () => new Date(now),
      idGenerator: createIdGenerator("read"),
    });
    const service = new FakeBrokerReconciliationService({
      memoryDir,
      broker,
      now: () => new Date(now),
      idGenerator: createIdGenerator("recon"),
    });

    const result = await service.run({
      requestId: "reconcile-001",
      accountId,
      local,
    });

    expect(result.reconciliation).toMatchObject({
      status: "mismatch",
      requiresManualReview: true,
      summary: {
        issueCount: 2,
        criticalIssueCount: 2,
      },
    });
    expect(result.notificationEvent).toMatchObject({
      severity: "critical",
      source: {
        type: "broker",
        id: "fake-broker-reconciliation-service",
      },
      target: {
        type: "account",
      },
      metadata: {
        account: "liv***-001",
        brokerSubmissionAllowed: false,
        orderSubmitted: false,
        liveTradingAllowed: false,
      },
    });

    const auditLogPath = createBrokerReconciliationAuditPath(memoryDir, now);
    const auditText = readFileSync(auditLogPath, "utf8");
    const auditEvents = auditText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => auditEventSchema.parse(JSON.parse(line)));
    const reconciliationAudit = auditEvents.find(
      (event) => event.actor.id === "fake-broker-reconciliation-service",
    );

    expect(reconciliationAudit).toMatchObject({
      action: "validate",
      severity: "critical",
      result: "failure",
      metadata: {
        requestId: "reconcile-001",
        status: "mismatch",
        account: "liv***-001",
        issueScopes: ["cash"],
        brokerSubmissionAllowed: false,
        orderSubmitted: false,
      },
    });
    expect(auditText).not.toContain(accountId);
  });

  it("opens account readOnly on reconciliation failure and requires manual clear", () => {
    const memoryDir = createTempMemoryDir();
    const mismatch = reconcilePortfolioSnapshots({
      reconciliationId: "recon-downgrade-001",
      accountId,
      checkedAt: now,
      local: makeSnapshot({
        account: makeAccount({ available: 12000, frozen: 0 }),
      }),
      broker: makeSnapshot({
        account: makeAccount({ available: 11900, frozen: 100 }),
      }),
    });

    const downgrade = applyReconciliationFailureDowngrade({
      memoryDir,
      result: mismatch,
      now: () => new Date(now),
      idGenerator: createIdGenerator("kill"),
    });
    const store = new LiveTradingSafetyStore({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator("read"),
    });
    const activeState = store.readKillSwitch();

    expect(downgrade).toMatchObject({
      applied: true,
      ruleId: "reconciliation-recon-downgrade-001",
      metadata: {
        requiresManualClear: true,
        brokerSubmissionAllowed: false,
      },
    });
    expect(activeState?.rules[0]).toMatchObject({
      scope: "account",
      mode: "readOnly",
      accountId,
      metadata: {
        reconciliationId: "recon-downgrade-001",
        requiresManualClear: true,
      },
    });

    const clear = clearReconciliationFailureDowngrade({
      memoryDir,
      accountId,
      reconciliationId: "recon-downgrade-001",
      clearedBy: {
        type: "user",
        id: "operator-001",
      },
      reason: "Manual reconciliation completed",
      now: () => new Date("2026-06-16T01:45:00.000Z"),
      idGenerator: createIdGenerator("clear"),
    });
    const clearedState = store.readKillSwitch();

    expect(clear).toMatchObject({
      applied: true,
      metadata: {
        requiresManualClear: false,
      },
    });
    expect(clearedState?.rules).toHaveLength(1);
    expect(clearedState?.rules[0]).toMatchObject({
      mode: "clear",
      updatedBy: {
        type: "user",
        id: "operator-001",
      },
      metadata: {
        clearedRuleIds: ["reconciliation-recon-downgrade-001"],
        manualClear: true,
      },
    });

    const auditText = readFileSync(path.join(memoryDir, "logs", "audit-2026-06-16.jsonl"), "utf8");
    expect(auditText).toContain("Kill switch state written");
    expect(auditText).toContain("clear-reconciliation-recon-downgrade-001");
    expect(auditText).not.toContain(accountId);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-fake-reconciliation-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function makeSnapshot(
  overrides: Partial<{
    account: ReturnType<typeof makeAccount>;
    positions: ReturnType<typeof makePosition>[];
    orders: ReturnType<typeof makeOrder>[];
    executions: never[];
  }> = {},
) {
  const order = makeOrder();

  return {
    account: overrides.account ?? makeAccount(),
    positions: overrides.positions ?? [makePosition()],
    orders: overrides.orders ?? [order],
    executions: overrides.executions ?? [],
  };
}

function makeAccount(overrides: { available?: number; frozen?: number } = {}) {
  return accountSchema.parse({
    accountId,
    type: "live",
    baseCurrency: "CNY",
    initialCash: 12000,
    cash: {
      available: overrides.available ?? 12000,
      frozen: overrides.frozen ?? 0,
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

function makeOrder() {
  return createOrderFromIntent({
    orderId: "order-000636",
    intent: tradeIntentSchema.parse({
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
    }),
    now,
  });
}

function createIdGenerator(prefix: string): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `${prefix}-${String(id).padStart(3, "0")}`;
  };
}
