import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  accountSchema,
  calculateAverageCostAfterBuy,
  calculateSellableQuantity,
  positionSchema,
  roundMoney,
  rollForwardPositionsForTradingDate,
  type Account,
  type Position,
  type TradeRecord,
  tradeRecordSchema,
} from "../../domain/portfolio/index.js";
import {
  PolicyEngine,
  type PolicyEngineOptions,
} from "../../domain/risk/index.js";
import {
  createExecutionReport,
  createOrderFromIntent,
  markOrderFilled,
  markOrderRejected,
  orderSchema,
  tradeIntentSchema,
  type ExecutionReport,
  type Order,
  type OrderRejectReason,
  type TradeIntent,
} from "../../domain/trading/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "../storage/atomic-file-writer.js";
import { JsonStore } from "../storage/json-store.js";
import { createPortfolioMemoryPaths, type PortfolioMemoryPaths } from "../storage/index.js";

const positionsSchema = z.array(positionSchema);
const ordersSchema = z.array(orderSchema);
const tradesSchema = z.array(tradeRecordSchema);

export interface PaperBrokerOptions {
  memoryDir: string;
  now?: () => Date;
  idGenerator?: () => string;
  writer?: AtomicFileWriter;
  t1Enabled?: boolean;
  feeCalculator?: PaperBrokerFeeCalculator;
  policyOptions?: PolicyEngineOptions;
}

export interface PaperBrokerFeeInput {
  side: TradeIntent["side"];
  quantity: number;
  price: number;
  grossAmount: number;
}

export interface PaperBrokerFeeResult {
  fees: number;
  tax: number;
}

export type PaperBrokerFeeCalculator = (input: PaperBrokerFeeInput) => PaperBrokerFeeResult;

export interface SubmitPaperOrderResult {
  idempotent: boolean;
  order: Order;
  execution?: ExecutionReport;
  trade?: TradeRecord;
  account?: Account;
  positions?: Position[];
}

export class PaperBroker {
  private readonly memoryDir: string;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly writer: AtomicFileWriter;
  private readonly t1Enabled: boolean;
  private readonly feeCalculator: PaperBrokerFeeCalculator;
  private readonly policyEngine = new PolicyEngine();
  private readonly policyOptions: PolicyEngineOptions;

  constructor(options: PaperBrokerOptions) {
    this.memoryDir = options.memoryDir;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => cryptoRandomId());
    this.writer = options.writer ?? new AtomicFileWriter();
    this.t1Enabled = options.t1Enabled !== false;
    this.feeCalculator = options.feeCalculator ?? (() => ({ fees: 0, tax: 0 }));
    this.policyOptions = {
      ...options.policyOptions,
      t1Enabled: options.policyOptions?.t1Enabled ?? this.t1Enabled,
    };
  }

  getAccount(): Account {
    return this.accountStore().read();
  }

  getPositions(): Position[] {
    return this.positionsStore().read();
  }

  /**
   * T+1 cross-day rollover: settle prior-day buys into available shares for `tradingDate`
   * (Beijing YYYY-MM-DD; defaults to now). Persists only when something changed, and returns
   * the settled positions. Idempotent — safe to call at the start of every node / before a sell.
   */
  settleDailyT1(tradingDate?: string): { positions: Position[]; changed: number } {
    const date = tradingDate ?? formatTradeDate(this.now());
    const result = rollForwardPositionsForTradingDate(this.getPositions(), date);
    if (result.changed > 0) {
      this.positionsStore().write(result.positions);
    }
    return result;
  }

  getOrders(): Order[] {
    return readJsonLines(this.paths().ordersPath, ordersSchema);
  }

  getTrades(): TradeRecord[] {
    return readJsonLines(this.paths().tradesPath, tradesSchema);
  }

  submitOrder(intentInput: TradeIntent): SubmitPaperOrderResult {
    const intent = tradeIntentSchema.parse(intentInput);
    const existing = this.findExistingIntent(intent.intentId);

    if (existing) {
      return {
        idempotent: true,
        order: existing.order,
        execution: existing.trade ? executionFromTrade(existing.order, existing.trade) : undefined,
        trade: existing.trade,
      };
    }

    const now = this.now();
    const order = createOrderFromIntent({
      orderId: this.nextId("order"),
      intent,
      now,
    });
    const account = this.getAccount();
    // T+1 cross-day settlement: roll any prior-day todayBuyQuantity into availableQuantity
    // BEFORE evaluating this order, so a sell the day after a buy is no longer wrongly blocked.
    const positions = this.settleDailyT1(formatTradeDate(now)).positions;

    const policyCheck = this.policyEngine.checkOrder({
      order,
      account,
      positions,
      options: this.policyOptions,
    });

    if (policyCheck.decision === "rejected") {
      return this.reject(order, policyCheck.reason!);
    }

    return intent.side === "BUY"
      ? this.executeBuy(order, account, positions)
      : this.executeSell(order, account, positions);
  }

  private executeBuy(order: Order, account: Account, positions: Position[]): SubmitPaperOrderResult {
    const grossAmount = roundMoney(order.quantity * order.limitPrice);
    const { fees, tax } = this.normalizeFees(
      this.feeCalculator({
        side: order.side,
        quantity: order.quantity,
        price: order.limitPrice,
        grossAmount,
      }),
    );
    const netAmount = roundMoney(grossAmount + fees + tax);

    if (account.cash.available < netAmount) {
      return this.reject(order, {
        code: "insufficient_cash",
        message: `Available cash ${account.cash.available} is less than required ${netAmount}`,
      });
    }

    const now = this.now();
    const execution = createExecutionReport({
      executionId: this.nextId("exec"),
      tradeId: this.nextId("trade"),
      order,
      fees,
      tax,
      executedAt: now,
    });
    const updatedAccount = accountSchema.parse({
      ...account,
      cash: {
        ...account.cash,
        available: roundMoney(account.cash.available - execution.netAmount),
      },
      // Honest trade time can predate the account's createdAt (e.g. a reset-then-replay of
      // today's morning, or replaying a day before the account existed). The account record
      // is genuinely written now, so clamp its updatedAt to >= createdAt; the TRADE keeps the
      // simulated time. Without this, accountSchema rejects the write and the fill is lost.
      updatedAt: maxIso(now.toISOString(), account.createdAt),
    });
    const updatedPositions = upsertBuyPosition(positions, order, fees + tax, now);
    const trade = tradeRecordFromExecution(execution, now);
    const filledOrder = markOrderFilled(order, now);

    this.persistFilledOrder(filledOrder, execution, trade, updatedAccount, updatedPositions);

    return {
      idempotent: false,
      order: filledOrder,
      execution,
      trade,
      account: updatedAccount,
      positions: updatedPositions,
    };
  }

  private executeSell(order: Order, account: Account, positions: Position[]): SubmitPaperOrderResult {
    const positionIndex = positions.findIndex(
      (position) =>
        position.accountId === order.accountId &&
        position.symbol === order.symbol &&
        position.market === order.market,
    );

    if (positionIndex < 0) {
      return this.reject(order, {
        code: "position_not_found",
        message: `No position found for ${order.symbol}`,
      });
    }

    const position = positions[positionIndex]!;
    const sellableQuantity = calculateSellableQuantity(position, {
      t1Enabled: this.t1Enabled,
    });

    if (order.quantity > sellableQuantity) {
      return this.reject(order, {
        code: "insufficient_sellable_quantity",
        message: `Sell quantity ${order.quantity} exceeds sellable quantity ${sellableQuantity}`,
      });
    }

    const grossAmount = roundMoney(order.quantity * order.limitPrice);
    const { fees, tax } = this.normalizeFees(
      this.feeCalculator({
        side: order.side,
        quantity: order.quantity,
        price: order.limitPrice,
        grossAmount,
      }),
    );
    const netAmount = roundMoney(grossAmount - fees - tax);

    if (netAmount <= 0) {
      return this.reject(order, {
        code: "non_positive_net_amount",
        message: `Sell net amount must be positive, got ${netAmount}`,
      });
    }

    const now = this.now();
    const execution = createExecutionReport({
      executionId: this.nextId("exec"),
      tradeId: this.nextId("trade"),
      order,
      fees,
      tax,
      executedAt: now,
    });
    const updatedAccount = accountSchema.parse({
      ...account,
      cash: {
        ...account.cash,
        available: roundMoney(account.cash.available + execution.netAmount),
      },
      // See executeBuy: clamp account.updatedAt to >= createdAt so a simulated (past) fill
      // time can't violate the account invariant; the TRADE keeps the simulated time.
      updatedAt: maxIso(now.toISOString(), account.createdAt),
    });
    const updatedPositions = applySellPosition(positions, positionIndex, order, now);
    const trade = tradeRecordFromExecution(execution, now);
    const filledOrder = markOrderFilled(order, now);

    this.persistFilledOrder(filledOrder, execution, trade, updatedAccount, updatedPositions);

    return {
      idempotent: false,
      order: filledOrder,
      execution,
      trade,
      account: updatedAccount,
      positions: updatedPositions,
    };
  }

  private reject(order: Order, reason: OrderRejectReason): SubmitPaperOrderResult {
    const rejectedOrder = markOrderRejected(order, reason, this.now());

    appendJsonLine(this.paths().ordersPath, rejectedOrder, this.writer);
    appendAuditEvent(this.paths().auditLogPath, auditEventForOrder(rejectedOrder), this.writer);

    return {
      idempotent: false,
      order: rejectedOrder,
    };
  }

  private persistFilledOrder(
    order: Order,
    execution: ExecutionReport,
    trade: TradeRecord,
    account: Account,
    positions: Position[],
  ): void {
    this.accountStore().write(account);
    this.positionsStore().write(positions);
    appendJsonLine(this.paths().ordersPath, order, this.writer);
    appendJsonLine(this.paths().tradesPath, trade, this.writer);
    appendAuditEvent(this.paths().auditLogPath, auditEventForOrder(order, execution), this.writer);
  }

  private findExistingIntent(intentId: string): { order: Order; trade?: TradeRecord } | undefined {
    const order = this.getOrders().find((candidate) => candidate.intentId === intentId);

    if (!order) {
      return undefined;
    }

    return {
      order,
      trade: this.getTrades().find((trade) => trade.intentId === intentId),
    };
  }

  private accountStore(): JsonStore<Account> {
    return new JsonStore({
      filePath: this.paths().accountPath,
      schema: accountSchema,
      writer: this.writer,
    });
  }

  private positionsStore(): JsonStore<Position[]> {
    return new JsonStore({
      filePath: this.paths().positionsPath,
      schema: z.array(positionSchema),
      writer: this.writer,
    });
  }

  private paths(): PortfolioMemoryPaths {
    return createPortfolioMemoryPaths(this.memoryDir, this.now().toISOString());
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.idGenerator()}`;
  }

  private normalizeFees(fees: PaperBrokerFeeResult): PaperBrokerFeeResult {
    return {
      fees: roundMoney(fees.fees),
      tax: roundMoney(fees.tax),
    };
  }
}

function upsertBuyPosition(
  positions: Position[],
  order: Order,
  extraCost: number,
  now: Date,
): Position[] {
  const index = positions.findIndex(
    (position) =>
      position.accountId === order.accountId &&
      position.symbol === order.symbol &&
      position.market === order.market,
  );

  if (index < 0) {
    return [
      ...positions,
      positionSchema.parse({
        accountId: order.accountId,
        symbol: order.symbol,
        market: order.market,
        name: order.name ?? order.symbol,
        quantity: order.quantity,
        availableQuantity: 0,
        todayBuyQuantity: order.quantity,
        frozenQuantity: 0,
        costPrice: calculateAverageCostAfterBuy({
          existingQuantity: 0,
          existingCostPrice: 0,
          buyQuantity: order.quantity,
          buyPrice: order.limitPrice,
          buyFees: extraCost,
        }),
        latestPrice: order.limitPrice,
        currency: order.currency,
        openedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastBuyTradeDate: formatTradeDate(now),
      }),
    ];
  }

  const existing = positions[index]!;
  const updated = positionSchema.parse({
    ...existing,
    quantity: existing.quantity + order.quantity,
    todayBuyQuantity: existing.todayBuyQuantity + order.quantity,
    costPrice: calculateAverageCostAfterBuy({
      existingQuantity: existing.quantity,
      existingCostPrice: existing.costPrice,
      buyQuantity: order.quantity,
      buyPrice: order.limitPrice,
      buyFees: extraCost,
    }),
    latestPrice: order.limitPrice,
    updatedAt: now.toISOString(),
    lastBuyTradeDate: formatTradeDate(now),
  });

  return positions.map((position, candidateIndex) => (candidateIndex === index ? updated : position));
}

function applySellPosition(
  positions: Position[],
  positionIndex: number,
  order: Order,
  now: Date,
): Position[] {
  const existing = positions[positionIndex]!;
  const remainingQuantity = existing.quantity - order.quantity;
  const remainingAvailableQuantity = Math.max(0, existing.availableQuantity - order.quantity);

  if (remainingQuantity === 0) {
    return positions.filter((_, index) => index !== positionIndex);
  }

  const updated = positionSchema.parse({
    ...existing,
    quantity: remainingQuantity,
    availableQuantity: remainingAvailableQuantity,
    latestPrice: order.limitPrice,
    updatedAt: now.toISOString(),
  });

  return positions.map((position, candidateIndex) =>
    candidateIndex === positionIndex ? updated : position,
  );
}

/** Later of two ISO timestamps — used to keep account.updatedAt >= createdAt under simulated fills. */
function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function tradeRecordFromExecution(execution: ExecutionReport, now: Date): TradeRecord {
  return tradeRecordSchema.parse({
    tradeId: execution.tradeId,
    accountId: execution.accountId,
    intentId: execution.intentId,
    orderId: execution.orderId,
    symbol: execution.symbol,
    market: execution.market,
    side: execution.side,
    quantity: execution.quantity,
    price: execution.price,
    grossAmount: execution.grossAmount,
    fees: execution.fees,
    tax: execution.tax,
    netAmount: execution.netAmount,
    currency: execution.currency,
    tradeDate: formatTradeDate(now),
    tradedAt: execution.executedAt,
    source: "paper",
  });
}

function executionFromTrade(order: Order, trade: TradeRecord): ExecutionReport {
  return {
    executionId: `exec-${trade.tradeId}`,
    orderId: order.orderId,
    intentId: trade.intentId ?? order.intentId,
    accountId: trade.accountId,
    symbol: trade.symbol,
    market: trade.market,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    grossAmount: trade.grossAmount,
    fees: trade.fees,
    tax: trade.tax,
    netAmount: trade.netAmount,
    currency: trade.currency,
    tradeId: trade.tradeId,
    executedAt: trade.tradedAt,
  };
}

function auditEventForOrder(order: Order, execution?: ExecutionReport): AuditEvent {
  const success = order.status === "filled";
  const result = success ? "success" : "rejected";

  return auditEventSchema.parse({
    eventId: `audit-${order.orderId}`,
    occurredAt: order.updatedAt,
    actor: {
      type: "broker",
      id: "paper-broker",
    },
    action: "order",
    subject: {
      type: "order",
      id: order.orderId,
    },
    severity: success ? "info" : "warning",
    result,
    message: success
      ? `Paper order ${order.orderId} filled`
      : `Paper order ${order.orderId} rejected: ${order.rejectReason?.message}`,
    correlationId: order.intentId,
    metadata: {
      accountId: order.accountId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      status: order.status,
      tradeId: execution?.tradeId ?? null,
      liveTrading: false,
    },
  });
}

function readJsonLines<T>(filePath: string, schema: z.ZodType<T[]>): T[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf8").trim();

  if (!content) {
    return [];
  }

  const parsed = content.split(/\r?\n/).map((line) => JSON.parse(line)) as unknown[];
  return schema.parse(parsed);
}

function appendJsonLine<T>(filePath: string, value: T, writer: AtomicFileWriter): void {
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";
  writer.write(filePath, `${previous}${separator}${JSON.stringify(value)}\n`);
}

function formatTradeDate(date: Date): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}
