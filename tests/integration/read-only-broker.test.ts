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
  tradeIntentSchema,
} from "../../src/domain/trading/index.js";
import {
  FakeReadOnlyBroker,
  createReadOnlyBrokerAuditLogPath,
} from "../../src/infrastructure/broker/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";
const accountId = "readonly-live-account-001";

describe("ReadOnlyBroker", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("exposes only query methods and audits read metadata without raw account identifiers", async () => {
    const memoryDir = createTempMemoryDir();
    const broker = createBroker(memoryDir);

    expect("submitOrder" in broker).toBe(false);
    expect("cancelOrder" in broker).toBe(false);

    await expect(broker.getAccountSnapshot(makeReadRequest("read-account"))).resolves.toMatchObject({
      accountId,
      type: "live",
    });
    await expect(broker.getCash(makeReadRequest("read-cash"))).resolves.toEqual({
      available: 12000,
      frozen: 300,
    });
    await expect(broker.getPositions(makeReadRequest("read-positions"))).resolves.toHaveLength(1);
    await expect(broker.getOrders(makeReadRequest("read-orders"))).resolves.toHaveLength(1);
    await expect(broker.getExecutions(makeReadRequest("read-executions"))).resolves.toEqual([]);

    const auditLogPath = createReadOnlyBrokerAuditLogPath(memoryDir, now);
    const auditText = readFileSync(auditLogPath, "utf8");
    const events = auditText
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => auditEventSchema.parse(JSON.parse(line)));

    expect(events).toHaveLength(5);
    expect(events.map((event) => event.action)).toEqual([
      "read",
      "read",
      "read",
      "read",
      "read",
    ]);
    expect(events.map((event) => event.actor.id)).toEqual([
      "fake-read-only-broker",
      "fake-read-only-broker",
      "fake-read-only-broker",
      "fake-read-only-broker",
      "fake-read-only-broker",
    ]);
    expect(events.at(-1)).toMatchObject({
      subject: {
        type: "trade",
        id: "executions",
      },
      metadata: {
        requestId: "read-executions",
        maskedAccountId: "rea***-001",
        brokerConnected: false,
        liveBrokerCalled: false,
        submitOrderAvailable: false,
        cancelOrderAvailable: false,
      },
    });
    expect(auditText).not.toContain(accountId);
    expect(auditText).not.toContain("token");
    expect(auditText).not.toContain("secret");
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-read-only-broker-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function createBroker(memoryDir: string): FakeReadOnlyBroker {
  let id = 0;
  const order = createOrderFromIntent({
    orderId: "readonly-order-001",
    intent: tradeIntentSchema.parse({
      intentId: "readonly-intent-001",
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

  return new FakeReadOnlyBroker({
    memoryDir,
    account: accountSchema.parse({
      accountId,
      type: "live",
      baseCurrency: "CNY",
      initialCash: 12000,
      cash: {
        available: 12000,
        frozen: 300,
      },
      status: "active",
      createdAt: now,
      updatedAt: now,
    }),
    positions: [
      positionSchema.parse({
        accountId,
        symbol: "000636",
        market: "SZSE",
        name: "Fenghua Hi-Tech",
        quantity: 100,
        availableQuantity: 100,
        todayBuyQuantity: 0,
        frozenQuantity: 0,
        costPrice: 10,
        latestPrice: 11,
        currency: "CNY",
        openedAt: now,
        updatedAt: now,
      }),
    ],
    orders: [order],
    now: () => new Date(now),
    idGenerator: () => {
      id += 1;
      return String(id).padStart(4, "0");
    },
  });
}

function makeReadRequest(requestId: string) {
  return {
    requestId,
    accountId,
    requestedAt: now,
  };
}
