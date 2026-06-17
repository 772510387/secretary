import { z } from "zod";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../domain/portfolio/index.js";
import {
  createOrderFromIntent,
  executionReportSchema,
  markOrderRejected,
  orderSchema,
  tradeIntentSchema,
  type ExecutionReport,
  type Order,
  type TradeIntent,
} from "../../domain/trading/index.js";
import type { LiveTradingGateResult } from "../../domain/trading/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain/shared/index.js";

export const liveBrokerProviderKindSchema = z.enum([
  "fake_live",
  "qmt",
  "ptrade",
]);

export const liveBrokerActionStatusSchema = z.enum([
  "accepted",
  "cancelled",
  "rejected",
  "unknown",
]);

export const fakeLiveBrokerBehaviorSchema = z.enum([
  "success",
  "reject",
  "unknown",
  "timeout",
]);

export type LiveBrokerProviderKind = z.infer<typeof liveBrokerProviderKindSchema>;
export type LiveBrokerActionStatus = z.infer<typeof liveBrokerActionStatusSchema>;
export type FakeLiveBrokerBehavior = z.infer<typeof fakeLiveBrokerBehaviorSchema>;

export interface LiveBrokerReadRequest {
  requestId: string;
  accountId: string;
  requestedAt?: string;
}

export interface LiveBrokerSubmitOrderInput {
  requestId: string;
  intent: TradeIntent;
  gateResult: LiveTradingGateResult;
  requestedAt?: string;
}

export interface LiveBrokerCancelOrderInput {
  requestId: string;
  accountId: string;
  brokerOrderId: string;
  gateResult: LiveTradingGateResult;
  requestedAt?: string;
}

export interface LiveBrokerSubmitOrderResult {
  requestId: string;
  status: LiveBrokerActionStatus;
  duplicate: boolean;
  brokerOrderId?: string;
  order?: Order;
  execution?: ExecutionReport;
  rejection?: {
    code: string;
    message: string;
  };
  metadata: {
    provider: LiveBrokerProviderKind;
    gateDecision: LiveTradingGateResult["decision"];
    gateAllowed: boolean;
    brokerConnected: boolean;
    liveBrokerCalled: boolean;
    orderSubmitted: boolean;
  };
}

export interface LiveBrokerCancelOrderResult {
  requestId: string;
  status: LiveBrokerActionStatus;
  duplicate: boolean;
  brokerOrderId: string;
  order?: Order;
  rejection?: {
    code: string;
    message: string;
  };
  metadata: {
    provider: LiveBrokerProviderKind;
    gateDecision: LiveTradingGateResult["decision"];
    gateAllowed: boolean;
    brokerConnected: boolean;
    liveBrokerCalled: boolean;
    orderCancelled: boolean;
  };
}

export interface LiveBrokerAdapter {
  readonly provider: LiveBrokerProviderKind;
  getAccountSnapshot(request: LiveBrokerReadRequest): Promise<Account>;
  getCash(request: LiveBrokerReadRequest): Promise<Account["cash"]>;
  getPositions(request: LiveBrokerReadRequest): Promise<Position[]>;
  getOrders(request: LiveBrokerReadRequest): Promise<Order[]>;
  getExecutions(request: LiveBrokerReadRequest): Promise<ExecutionReport[]>;
  submitOrder(input: LiveBrokerSubmitOrderInput): Promise<LiveBrokerSubmitOrderResult>;
  cancelOrder(input: LiveBrokerCancelOrderInput): Promise<LiveBrokerCancelOrderResult>;
}

export interface FakeLiveBrokerAdapterOptions {
  account?: Account;
  positions?: Position[];
  orders?: Order[];
  executions?: ExecutionReport[];
  submitBehavior?: FakeLiveBrokerBehavior;
  cancelBehavior?: FakeLiveBrokerBehavior;
  now?: () => Date;
  idGenerator?: () => string;
}

export class LiveBrokerAdapterError extends Error {
  readonly code: string;
  readonly requestId?: string;

  constructor(message: string, options: { code: string; requestId?: string }) {
    super(message);
    this.name = "LiveBrokerAdapterError";
    this.code = options.code;
    this.requestId = options.requestId;
  }
}

export class FakeLiveBrokerAdapter implements LiveBrokerAdapter {
  readonly provider = "fake_live" as const;

  private account: Account;
  private positions: Position[];
  private orders: Order[];
  private executions: ExecutionReport[];
  private readonly submitBehavior: FakeLiveBrokerBehavior;
  private readonly cancelBehavior: FakeLiveBrokerBehavior;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly submitResults = new Map<string, LiveBrokerSubmitOrderResult>();
  private readonly cancelResults = new Map<string, LiveBrokerCancelOrderResult>();

  constructor(options: FakeLiveBrokerAdapterOptions = {}) {
    const now = options.now ?? (() => new Date());

    this.now = now;
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.account = accountSchema.parse(options.account ?? defaultLiveAccount(now()));
    this.positions = z.array(positionSchema).parse(options.positions ?? []);
    this.orders = z.array(orderSchema).parse(options.orders ?? []);
    this.executions = z.array(executionReportSchema).parse(options.executions ?? []);
    this.submitBehavior = fakeLiveBrokerBehaviorSchema.parse(options.submitBehavior ?? "success");
    this.cancelBehavior = fakeLiveBrokerBehaviorSchema.parse(options.cancelBehavior ?? "success");
  }

  async getAccountSnapshot(request: LiveBrokerReadRequest): Promise<Account> {
    parseReadRequest(request);
    return accountSchema.parse(this.account);
  }

  async getCash(request: LiveBrokerReadRequest): Promise<Account["cash"]> {
    parseReadRequest(request);
    return accountSchema.parse(this.account).cash;
  }

  async getPositions(request: LiveBrokerReadRequest): Promise<Position[]> {
    parseReadRequest(request);
    return z.array(positionSchema).parse(this.positions);
  }

  async getOrders(request: LiveBrokerReadRequest): Promise<Order[]> {
    parseReadRequest(request);
    return z.array(orderSchema).parse(this.orders);
  }

  async getExecutions(request: LiveBrokerReadRequest): Promise<ExecutionReport[]> {
    parseReadRequest(request);
    return z.array(executionReportSchema).parse(this.executions);
  }

  async submitOrder(input: LiveBrokerSubmitOrderInput): Promise<LiveBrokerSubmitOrderResult> {
    const parsed = parseSubmitInput(input);
    const previous = this.submitResults.get(parsed.requestId);

    if (previous) {
      return {
        ...cloneSubmitResult(previous),
        duplicate: true,
      };
    }

    if (!parsed.gateResult.allowed) {
      const result: LiveBrokerSubmitOrderResult = {
        requestId: parsed.requestId,
        status: "rejected",
        duplicate: false,
        rejection: {
          code: "live_gate_rejected",
          message: "LiveTradingGateResult did not allow submit_order",
        },
        metadata: metadataForSubmit(parsed.gateResult, {
          liveBrokerCalled: false,
          orderSubmitted: false,
        }),
      };
      this.submitResults.set(parsed.requestId, result);
      return cloneSubmitResult(result);
    }

    if (this.submitBehavior === "timeout") {
      throw new LiveBrokerAdapterError("Fake live broker submit timed out", {
        code: "timeout",
        requestId: parsed.requestId,
      });
    }

    const created = createOrderFromIntent({
      orderId: `live-order-${safeIdentifier(this.idGenerator())}`,
      intent: parsed.intent,
      now: parsed.requestedAt ?? this.now(),
    });

    const result = this.resultForSubmitBehavior(parsed, created);
    this.submitResults.set(parsed.requestId, result);
    this.orders = [...this.orders, result.order].filter((order): order is Order => order !== undefined);

    return cloneSubmitResult(result);
  }

  async cancelOrder(input: LiveBrokerCancelOrderInput): Promise<LiveBrokerCancelOrderResult> {
    const parsed = parseCancelInput(input);
    const previous = this.cancelResults.get(parsed.requestId);

    if (previous) {
      return {
        ...cloneCancelResult(previous),
        duplicate: true,
      };
    }

    if (!parsed.gateResult.allowed) {
      const result: LiveBrokerCancelOrderResult = {
        requestId: parsed.requestId,
        status: "rejected",
        duplicate: false,
        brokerOrderId: parsed.brokerOrderId,
        rejection: {
          code: "live_gate_rejected",
          message: "LiveTradingGateResult did not allow cancel_order",
        },
        metadata: metadataForCancel(parsed.gateResult, {
          liveBrokerCalled: false,
          orderCancelled: false,
        }),
      };
      this.cancelResults.set(parsed.requestId, result);
      return cloneCancelResult(result);
    }

    if (this.cancelBehavior === "timeout") {
      throw new LiveBrokerAdapterError("Fake live broker cancel timed out", {
        code: "timeout",
        requestId: parsed.requestId,
      });
    }

    const orderIndex = this.orders.findIndex((order) => order.orderId === parsed.brokerOrderId);
    const existing = orderIndex >= 0 ? this.orders[orderIndex] : undefined;
    const result = this.resultForCancelBehavior(parsed, existing);

    if (result.order && orderIndex >= 0) {
      this.orders = [
        ...this.orders.slice(0, orderIndex),
        result.order,
        ...this.orders.slice(orderIndex + 1),
      ];
    }

    this.cancelResults.set(parsed.requestId, result);
    return cloneCancelResult(result);
  }

  private resultForSubmitBehavior(
    parsed: ParsedSubmitInput,
    created: Order,
  ): LiveBrokerSubmitOrderResult {
    if (this.submitBehavior === "reject") {
      const rejected = markOrderRejected(
        created,
        {
          code: "broker_rejected",
          message: "Fake live broker rejected the order",
        },
        parsed.requestedAt ?? this.now(),
      );

      return {
        requestId: parsed.requestId,
        status: "rejected",
        duplicate: false,
        brokerOrderId: rejected.orderId,
        order: rejected,
        rejection: rejected.rejectReason,
        metadata: metadataForSubmit(parsed.gateResult, {
          liveBrokerCalled: true,
          orderSubmitted: false,
        }),
      };
    }

    const submitted = orderSchema.parse({
      ...created,
      status: "submitted",
      updatedAt: normalizeDate(parsed.requestedAt ?? this.now()).toISOString(),
    });

    if (this.submitBehavior === "unknown") {
      return {
        requestId: parsed.requestId,
        status: "unknown",
        duplicate: false,
        brokerOrderId: submitted.orderId,
        order: submitted,
        rejection: {
          code: "broker_status_unknown",
          message: "Fake live broker returned an unknown submit status",
        },
        metadata: metadataForSubmit(parsed.gateResult, {
          liveBrokerCalled: true,
          orderSubmitted: false,
        }),
      };
    }

    return {
      requestId: parsed.requestId,
      status: "accepted",
      duplicate: false,
      brokerOrderId: submitted.orderId,
      order: submitted,
      metadata: metadataForSubmit(parsed.gateResult, {
        liveBrokerCalled: true,
        orderSubmitted: true,
      }),
    };
  }

  private resultForCancelBehavior(
    parsed: ParsedCancelInput,
    existing: Order | undefined,
  ): LiveBrokerCancelOrderResult {
    if (!existing) {
      return {
        requestId: parsed.requestId,
        status: "unknown",
        duplicate: false,
        brokerOrderId: parsed.brokerOrderId,
        rejection: {
          code: "broker_order_not_found",
          message: "Fake live broker could not find the order",
        },
        metadata: metadataForCancel(parsed.gateResult, {
          liveBrokerCalled: true,
          orderCancelled: false,
        }),
      };
    }

    if (this.cancelBehavior === "reject") {
      return {
        requestId: parsed.requestId,
        status: "rejected",
        duplicate: false,
        brokerOrderId: existing.orderId,
        order: existing,
        rejection: {
          code: "broker_cancel_rejected",
          message: "Fake live broker rejected the cancel request",
        },
        metadata: metadataForCancel(parsed.gateResult, {
          liveBrokerCalled: true,
          orderCancelled: false,
        }),
      };
    }

    if (this.cancelBehavior === "unknown") {
      return {
        requestId: parsed.requestId,
        status: "unknown",
        duplicate: false,
        brokerOrderId: existing.orderId,
        order: existing,
        rejection: {
          code: "broker_cancel_unknown",
          message: "Fake live broker returned an unknown cancel status",
        },
        metadata: metadataForCancel(parsed.gateResult, {
          liveBrokerCalled: true,
          orderCancelled: false,
        }),
      };
    }

    const cancelled = orderSchema.parse({
      ...existing,
      status: "cancelled",
      updatedAt: normalizeDate(parsed.requestedAt ?? this.now()).toISOString(),
    });

    return {
      requestId: parsed.requestId,
      status: "cancelled",
      duplicate: false,
      brokerOrderId: cancelled.orderId,
      order: cancelled,
      metadata: metadataForCancel(parsed.gateResult, {
        liveBrokerCalled: true,
        orderCancelled: true,
      }),
    };
  }
}

interface ParsedSubmitInput extends Omit<LiveBrokerSubmitOrderInput, "requestedAt"> {
  requestedAt?: string;
}

interface ParsedCancelInput extends Omit<LiveBrokerCancelOrderInput, "requestedAt"> {
  requestedAt?: string;
}

function parseReadRequest(request: LiveBrokerReadRequest): LiveBrokerReadRequest {
  return {
    requestId: identifierSchema.parse(request.requestId),
    accountId: identifierSchema.parse(request.accountId),
    requestedAt: request.requestedAt === undefined
      ? undefined
      : isoDateTimeSchema.parse(request.requestedAt),
  };
}

function parseSubmitInput(input: LiveBrokerSubmitOrderInput): ParsedSubmitInput {
  return {
    requestId: identifierSchema.parse(input.requestId),
    intent: tradeIntentSchema.parse(input.intent),
    gateResult: input.gateResult,
    requestedAt: input.requestedAt === undefined
      ? undefined
      : isoDateTimeSchema.parse(input.requestedAt),
  };
}

function parseCancelInput(input: LiveBrokerCancelOrderInput): ParsedCancelInput {
  return {
    requestId: identifierSchema.parse(input.requestId),
    accountId: identifierSchema.parse(input.accountId),
    brokerOrderId: identifierSchema.parse(input.brokerOrderId),
    gateResult: input.gateResult,
    requestedAt: input.requestedAt === undefined
      ? undefined
      : isoDateTimeSchema.parse(input.requestedAt),
  };
}

function defaultLiveAccount(now: Date): Account {
  const iso = now.toISOString();

  return accountSchema.parse({
    accountId: "fake-live-account",
    type: "live",
    baseCurrency: "CNY",
    initialCash: 0,
    cash: {
      available: 0,
      frozen: 0,
    },
    status: "active",
    createdAt: iso,
    updatedAt: iso,
  });
}

function metadataForSubmit(
  gateResult: LiveTradingGateResult,
  options: {
    liveBrokerCalled: boolean;
    orderSubmitted: boolean;
  },
): LiveBrokerSubmitOrderResult["metadata"] {
  return {
    provider: "fake_live",
    gateDecision: gateResult.decision,
    gateAllowed: gateResult.allowed,
    brokerConnected: false,
    liveBrokerCalled: options.liveBrokerCalled,
    orderSubmitted: options.orderSubmitted,
  };
}

function metadataForCancel(
  gateResult: LiveTradingGateResult,
  options: {
    liveBrokerCalled: boolean;
    orderCancelled: boolean;
  },
): LiveBrokerCancelOrderResult["metadata"] {
  return {
    provider: "fake_live",
    gateDecision: gateResult.decision,
    gateAllowed: gateResult.allowed,
    brokerConnected: false,
    liveBrokerCalled: options.liveBrokerCalled,
    orderCancelled: options.orderCancelled,
  };
}

function cloneSubmitResult(result: LiveBrokerSubmitOrderResult): LiveBrokerSubmitOrderResult {
  return {
    ...result,
    order: result.order ? orderSchema.parse(result.order) : undefined,
    execution: result.execution ? executionReportSchema.parse(result.execution) : undefined,
    rejection: result.rejection ? { ...result.rejection } : undefined,
    metadata: { ...result.metadata },
  };
}

function cloneCancelResult(result: LiveBrokerCancelOrderResult): LiveBrokerCancelOrderResult {
  return {
    ...result,
    order: result.order ? orderSchema.parse(result.order) : undefined,
    rejection: result.rejection ? { ...result.rejection } : undefined,
    metadata: { ...result.metadata },
  };
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new LiveBrokerAdapterError(`Invalid date: ${value}`, {
      code: "invalid_date",
    });
  }

  return parsed;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
