import {
  executionReportSchema,
  orderSchema,
  tradeIntentSchema,
  type ExecutionReport,
  type Order,
  type OrderRejectReason,
  type TradeIntent,
} from "./schemas.js";
import { roundMoney, roundPrice } from "../portfolio/index.js";

export interface CreateOrderInput {
  orderId: string;
  intent: TradeIntent;
  now: Date | string;
}

export interface CreateExecutionReportInput {
  executionId: string;
  tradeId: string;
  order: Order;
  price?: number;
  fees?: number;
  tax?: number;
  executedAt: Date | string;
}

export function createOrderFromIntent(input: CreateOrderInput): Order {
  const intent = tradeIntentSchema.parse(input.intent);
  const nowIso = normalizeDate(input.now).toISOString();

  return orderSchema.parse({
    orderId: input.orderId,
    intentId: intent.intentId,
    accountId: intent.accountId,
    symbol: intent.symbol,
    market: intent.market,
    name: intent.name,
    side: intent.side,
    type: "LIMIT",
    quantity: intent.quantity,
    limitPrice: roundPrice(intent.limitPrice),
    currency: intent.currency,
    status: "created",
    source: intent.source,
    createdAt: nowIso,
    updatedAt: nowIso,
  });
}

export function markOrderRejected(
  order: Order,
  rejectReason: OrderRejectReason,
  now: Date | string,
): Order {
  return orderSchema.parse({
    ...order,
    status: "rejected",
    rejectReason,
    updatedAt: normalizeDate(now).toISOString(),
  });
}

export function markOrderFilled(order: Order, now: Date | string): Order {
  return orderSchema.parse({
    ...order,
    status: "filled",
    updatedAt: normalizeDate(now).toISOString(),
  });
}

export function createExecutionReport(input: CreateExecutionReportInput): ExecutionReport {
  const price = roundPrice(input.price ?? input.order.limitPrice);
  const grossAmount = roundMoney(input.order.quantity * price);
  const fees = roundMoney(input.fees ?? 0);
  const tax = roundMoney(input.tax ?? 0);
  const netAmount =
    input.order.side === "BUY"
      ? roundMoney(grossAmount + fees + tax)
      : roundMoney(grossAmount - fees - tax);

  return executionReportSchema.parse({
    executionId: input.executionId,
    orderId: input.order.orderId,
    intentId: input.order.intentId,
    accountId: input.order.accountId,
    symbol: input.order.symbol,
    market: input.order.market,
    side: input.order.side,
    quantity: input.order.quantity,
    price,
    grossAmount,
    fees,
    tax,
    netAmount,
    currency: input.order.currency,
    tradeId: input.tradeId,
    executedAt: normalizeDate(input.executedAt).toISOString(),
  });
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new TradingDomainError(`Invalid date: ${value}`);
  }

  return parsed;
}

export class TradingDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradingDomainError";
  }
}

