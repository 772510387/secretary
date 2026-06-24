import { readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildInitialPaperAccountSeed } from "../../src/app/index.js";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import {
  orderSchema,
  tradeIntentSchema,
} from "../../src/domain/trading/index.js";
import { PaperBroker } from "../../src/infrastructure/broker/index.js";
import {
  JsonStore,
  createPortfolioMemoryPaths,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const baseNow = new Date("2026-06-12T01:30:00.000Z");

describe("PaperBroker", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("buys a new position, deducts cash, and writes order/trade/audit", () => {
    const memoryDir = createInitializedMemory();
    const broker = createBroker(memoryDir);
    const intent = makeIntent({
      intentId: "intent-buy-000636",
      side: "BUY",
      quantity: 100,
      limitPrice: 10,
    });

    const result = broker.submitOrder(intent);

    expect(result.idempotent).toBe(false);
    expect(result.order.status).toBe("filled");
    expect(result.execution?.netAmount).toBe(1000);
    expect(result.trade).toMatchObject({
      intentId: "intent-buy-000636",
      side: "BUY",
      quantity: 100,
      price: 10,
      netAmount: 1000,
      tradeDate: "2026-06-12",
    });
    expect(broker.getAccount().cash.available).toBe(19000);
    expect(broker.getPositions()).toMatchObject([
      {
        symbol: "000636",
        quantity: 100,
        availableQuantity: 0,
        todayBuyQuantity: 100,
        costPrice: 10,
      },
    ]);
    expect(broker.getOrders()).toHaveLength(1);
    expect(broker.getTrades()).toHaveLength(1);
    expect(readAuditEvents(memoryDir).at(-1)).toMatchObject({
      action: "order",
      result: "success",
      subject: {
        type: "order",
      },
    });
  });

  it("returns the original result for duplicate intent_id without double execution", () => {
    const memoryDir = createInitializedMemory();
    const broker = createBroker(memoryDir);
    const intent = makeIntent({
      intentId: "intent-duplicate-buy",
      side: "BUY",
      quantity: 100,
      limitPrice: 10,
    });

    const first = broker.submitOrder(intent);
    const second = broker.submitOrder(intent);

    expect(first.order.status).toBe("filled");
    expect(second.idempotent).toBe(true);
    expect(second.order.orderId).toBe(first.order.orderId);
    expect(broker.getAccount().cash.available).toBe(19000);
    expect(broker.getOrders()).toHaveLength(1);
    expect(broker.getTrades()).toHaveLength(1);
  });

  it("rejects buy orders when cash is insufficient and does not write a trade", () => {
    const memoryDir = createInitializedMemory();
    const broker = createBroker(memoryDir);

    const result = broker.submitOrder(
      makeIntent({
        intentId: "intent-buy-too-large",
        side: "BUY",
        quantity: 10000,
        limitPrice: 10,
      }),
    );

    expect(result.order.status).toBe("rejected");
    expect(result.order.rejectReason?.code).toBe("insufficient_cash");
    expect(broker.getAccount().cash.available).toBe(20000);
    expect(broker.getTrades()).toHaveLength(0);
    expect(broker.getOrders()).toHaveLength(1);
    expect(readAuditEvents(memoryDir).at(-1)).toMatchObject({
      result: "rejected",
      severity: "warning",
    });
  });

  it("applies PolicyEngine rules before paper execution", () => {
    const memoryDir = createInitializedMemory();
    const broker = createBroker(memoryDir);

    const nonMainBoard = broker.submitOrder(
      makeIntent({
        intentId: "intent-buy-kcb",
        symbol: "688001",
        market: "SSE",
        side: "BUY",
        quantity: 100,
        limitPrice: 10,
      }),
    );
    const invalidLot = broker.submitOrder(
      makeIntent({
        intentId: "intent-buy-odd-lot",
        side: "BUY",
        quantity: 50,
        limitPrice: 10,
      }),
    );

    expect(nonMainBoard.order.status).toBe("rejected");
    expect(nonMainBoard.order.rejectReason?.code).toBe("non_main_board");
    expect(invalidLot.order.status).toBe("rejected");
    expect(invalidLot.order.rejectReason?.code).toBe("invalid_lot_size");
    expect(broker.getAccount().cash.available).toBe(20000);
    expect(broker.getTrades()).toHaveLength(0);
    expect(broker.getOrders()).toHaveLength(2);
  });

  it("sells an available position and removes it when quantity reaches zero", () => {
    const memoryDir = createInitializedMemory();
    seedPositions(memoryDir, [
      makePosition({
        quantity: 100,
        availableQuantity: 100,
        todayBuyQuantity: 0,
        costPrice: 8,
        latestPrice: 10,
      }),
    ]);
    const broker = createBroker(memoryDir);

    const result = broker.submitOrder(
      makeIntent({
        intentId: "intent-sell-000636",
        side: "SELL",
        quantity: 100,
        limitPrice: 12,
      }),
    );

    expect(result.order.status).toBe("filled");
    expect(result.trade).toMatchObject({
      side: "SELL",
      grossAmount: 1200,
      netAmount: 1200,
    });
    expect(broker.getAccount().cash.available).toBe(21200);
    expect(broker.getPositions()).toEqual([]);
    expect(broker.getTrades()).toHaveLength(1);
  });

  it("rejects sell orders when sellable quantity is insufficient", () => {
    const memoryDir = createInitializedMemory();
    seedPositions(memoryDir, [
      makePosition({
        quantity: 100,
        availableQuantity: 100,
        todayBuyQuantity: 100,
        costPrice: 10,
      }),
    ]);
    const broker = createBroker(memoryDir);

    const result = broker.submitOrder(
      makeIntent({
        intentId: "intent-sell-t1-blocked",
        side: "SELL",
        quantity: 100,
        limitPrice: 12,
      }),
    );

    expect(result.order.status).toBe("rejected");
    expect(result.order.rejectReason?.code).toBe("insufficient_sellable_quantity");
    expect(broker.getAccount().cash.available).toBe(20000);
    expect(broker.getTrades()).toHaveLength(0);
    expect(broker.getPositions()[0]?.quantity).toBe(100);
  });

  it("updates weighted average cost when buying an existing position", () => {
    const memoryDir = createInitializedMemory();
    seedPositions(memoryDir, [
      makePosition({
        quantity: 100,
        availableQuantity: 100,
        todayBuyQuantity: 0,
        costPrice: 10,
      }),
    ]);
    const broker = createBroker(memoryDir, {
      feeSequence: [{ fees: 5, tax: 0 }],
    });

    const result = broker.submitOrder(
      makeIntent({
        intentId: "intent-buy-more",
        side: "BUY",
        quantity: 100,
        limitPrice: 12,
      }),
    );

    expect(result.order.status).toBe("filled");
    expect(broker.getAccount().cash.available).toBe(18795);
    expect(broker.getPositions()[0]).toMatchObject({
      quantity: 200,
      availableQuantity: 100,
      todayBuyQuantity: 100,
      costPrice: 11.025,
    });
  });

  it("settles T+1 across days so a prior-day buy becomes sellable (HAND-02/03)", () => {
    const memoryDir = createInitializedMemory();
    seedPositions(memoryDir, [
      makePosition({
        symbol: "000636",
        quantity: 100,
        availableQuantity: 0,
        todayBuyQuantity: 100,
        lastBuyTradeDate: "2026-06-12",
      }),
    ]);

    const laterDay = new Date("2026-06-15T01:30:00.000Z");
    let id = 0;
    const broker = new PaperBroker({
      memoryDir,
      now: () => laterDay,
      idGenerator: () => String((id += 1)).padStart(4, "0"),
    });

    const result = broker.submitOrder(
      makeIntent({
        intentId: "intent-sell-cross-day",
        side: "SELL",
        quantity: 100,
        limitPrice: 12,
        createdAt: laterDay.toISOString(),
      }),
    );

    expect(result.order.status).toBe("filled");
    expect(broker.getPositions()).toHaveLength(0); // fully sold after T+1 settlement
    expect(broker.getAccount().cash.available).toBe(21200); // 20000 + 100*12 proceeds
  });

  it("still blocks a same-day sell of freshly bought shares (T+1 intact)", () => {
    const memoryDir = createInitializedMemory();
    const broker = createBroker(memoryDir); // now == baseNow (2026-06-12)
    broker.submitOrder(makeIntent({ intentId: "intent-buy-same-day", side: "BUY", quantity: 100, limitPrice: 10 }));

    const sell = broker.submitOrder(
      makeIntent({ intentId: "intent-sell-same-day", side: "SELL", quantity: 100, limitPrice: 11 }),
    );

    expect(sell.order.status).toBe("rejected");
    expect(sell.order.rejectReason?.code).toBe("insufficient_sellable_quantity");
  });
});

function createInitializedMemory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-paper-broker-"));
  tempRoots.push(root);
  const memoryDir = path.join(root, "memory");
  const seed = buildInitialPaperAccountSeed({
    now: baseNow,
    initialCash: 20000,
  });

  initializePaperAccountMemory({ memoryDir, seed, dryRun: false });
  return memoryDir;
}

function createBroker(
  memoryDir: string,
  options: { feeSequence?: Array<{ fees: number; tax: number }> } = {},
): PaperBroker {
  let id = 0;
  let feeIndex = 0;

  return new PaperBroker({
    memoryDir,
    now: () => baseNow,
    idGenerator: () => {
      id += 1;
      return String(id).padStart(4, "0");
    },
    feeCalculator: () => {
      const fee = options.feeSequence?.[feeIndex] ?? { fees: 0, tax: 0 };
      feeIndex += 1;
      return fee;
    },
  });
}

function makeIntent(overrides: Partial<z.input<typeof tradeIntentSchema>>) {
  return tradeIntentSchema.parse({
    intentId: "intent-0001",
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    side: "BUY",
    quantity: 100,
    limitPrice: 10,
    currency: "CNY",
    source: "test",
    createdAt: baseNow.toISOString(),
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
    openedAt: baseNow.toISOString(),
    updatedAt: baseNow.toISOString(),
    ...overrides,
  });
}

function seedPositions(memoryDir: string, positions: Position[]): void {
  const paths = createPortfolioMemoryPaths(memoryDir, baseNow.toISOString());
  const store = new JsonStore<Position[]>({
    filePath: paths.positionsPath,
    schema: z.array(positionSchema),
  });

  store.write(positions);
}

function readAuditEvents(memoryDir: string) {
  const paths = createPortfolioMemoryPaths(memoryDir, baseNow.toISOString());
  const lines = readFileSync(paths.auditLogPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);

  return lines.map((line) => auditEventSchema.parse(JSON.parse(line)));
}
