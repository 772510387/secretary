import { z } from "zod";
import {
  calculateSellableQuantity,
  roundMoney,
  roundPrice,
} from "../portfolio/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../portfolio/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";
import {
  executionReportSchema,
  orderSchema,
  type ExecutionReport,
  type Order,
} from "./schemas.js";

export const reconciliationStatusSchema = z.enum([
  "matched",
  "mismatch",
  "unknown",
  "needs_manual_review",
]);

export const reconciliationScopeSchema = z.enum([
  "cash",
  "position",
  "sellable",
  "frozen",
  "order",
  "execution",
  "intent_mapping",
]);

export const reconciliationSeveritySchema = z.enum(["info", "warning", "critical"]);

export const reconciliationIssueSchema = z
  .object({
    issueId: identifierSchema,
    status: reconciliationStatusSchema,
    scope: reconciliationScopeSchema,
    severity: reconciliationSeveritySchema,
    ref: z.string().trim().min(1).max(240),
    field: z.string().trim().min(1).max(120).optional(),
    localValue: jsonValueSchema.optional(),
    brokerValue: jsonValueSchema.optional(),
    message: z.string().trim().min(1).max(1000),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const reconciliationCashComparisonSchema = z
  .object({
    status: reconciliationStatusSchema,
    localAvailable: z.number().finite().nonnegative().optional(),
    brokerAvailable: z.number().finite().nonnegative().optional(),
    localFrozen: z.number().finite().nonnegative().optional(),
    brokerFrozen: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const reconciliationPositionComparisonSchema = z
  .object({
    key: z.string().trim().min(1).max(32),
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    status: reconciliationStatusSchema,
    localQuantity: z.number().int().nonnegative().optional(),
    brokerQuantity: z.number().int().nonnegative().optional(),
    localSellableQuantity: z.number().int().nonnegative().optional(),
    brokerSellableQuantity: z.number().int().nonnegative().optional(),
    localFrozenQuantity: z.number().int().nonnegative().optional(),
    brokerFrozenQuantity: z.number().int().nonnegative().optional(),
  })
  .strict();

export const reconciliationOrderComparisonSchema = z
  .object({
    orderId: identifierSchema,
    intentId: identifierSchema,
    status: reconciliationStatusSchema,
    localOrderStatus: z.string().trim().min(1).max(40).optional(),
    brokerOrderStatus: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

export const reconciliationExecutionComparisonSchema = z
  .object({
    executionId: identifierSchema,
    orderId: identifierSchema,
    intentId: identifierSchema,
    status: reconciliationStatusSchema,
    localQuantity: z.number().int().positive().optional(),
    brokerQuantity: z.number().int().positive().optional(),
    localPrice: z.number().finite().positive().optional(),
    brokerPrice: z.number().finite().positive().optional(),
  })
  .strict();

export const reconciliationIntentMappingSchema = z
  .object({
    intentId: identifierSchema,
    status: reconciliationStatusSchema,
    localOrderIds: z.array(identifierSchema).default([]),
    brokerOrderIds: z.array(identifierSchema).default([]),
  })
  .strict();

export const reconciliationResultSchema = z
  .object({
    reconciliationId: identifierSchema,
    accountId: identifierSchema,
    checkedAt: isoDateTimeSchema,
    status: reconciliationStatusSchema,
    cash: reconciliationCashComparisonSchema,
    positions: z.array(reconciliationPositionComparisonSchema).default([]),
    orders: z.array(reconciliationOrderComparisonSchema).default([]),
    executions: z.array(reconciliationExecutionComparisonSchema).default([]),
    intentMappings: z.array(reconciliationIntentMappingSchema).default([]),
    issues: z.array(reconciliationIssueSchema).default([]),
    summary: z
      .object({
        cashStatus: reconciliationStatusSchema,
        positionCount: z.number().int().nonnegative(),
        orderCount: z.number().int().nonnegative(),
        executionCount: z.number().int().nonnegative(),
        intentMappingCount: z.number().int().nonnegative(),
        issueCount: z.number().int().nonnegative(),
        criticalIssueCount: z.number().int().nonnegative(),
      })
      .strict(),
    requiresManualReview: z.boolean(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>;
export type ReconciliationScope = z.infer<typeof reconciliationScopeSchema>;
export type ReconciliationSeverity = z.infer<typeof reconciliationSeveritySchema>;
export type ReconciliationIssue = z.infer<typeof reconciliationIssueSchema>;
export type ReconciliationCashComparison = z.infer<typeof reconciliationCashComparisonSchema>;
export type ReconciliationPositionComparison = z.infer<typeof reconciliationPositionComparisonSchema>;
export type ReconciliationOrderComparison = z.infer<typeof reconciliationOrderComparisonSchema>;
export type ReconciliationExecutionComparison = z.infer<typeof reconciliationExecutionComparisonSchema>;
export type ReconciliationIntentMapping = z.infer<typeof reconciliationIntentMappingSchema>;
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

export interface ReconciliationSnapshot {
  account?: Account;
  positions?: Position[];
  orders?: Order[];
  executions?: ExecutionReport[];
}

export interface ReconcilePortfolioSnapshotsInput {
  reconciliationId?: string;
  accountId: string;
  checkedAt: string;
  local: ReconciliationSnapshot;
  broker: ReconciliationSnapshot;
  metadata?: Record<string, unknown>;
}

interface ParsedReconciliationSnapshot {
  account?: Account;
  positions: Position[];
  orders: Order[];
  executions: ExecutionReport[];
}

export function reconcilePortfolioSnapshots(
  input: ReconcilePortfolioSnapshotsInput,
): ReconciliationResult {
  const checkedAt = isoDateTimeSchema.parse(input.checkedAt);
  const accountId = identifierSchema.parse(input.accountId);
  const local = parseSnapshot(input.local);
  const broker = parseSnapshot(input.broker);
  const issues = issueCollector(input.reconciliationId ?? defaultReconciliationId(accountId, checkedAt));
  const cash = compareCash(local.account, broker.account, issues);
  const positions = comparePositions(local.positions, broker.positions, issues);
  const orders = compareOrders(local.orders, broker.orders, issues);
  const executions = compareExecutions(local.executions, broker.executions, issues);
  const intentMappings = compareIntentMappings(local.orders, broker.orders, issues);
  const collectedIssues = issues.items();
  const status = aggregateStatus(collectedIssues.map((issue) => issue.status));

  return reconciliationResultSchema.parse({
    reconciliationId: input.reconciliationId ?? defaultReconciliationId(accountId, checkedAt),
    accountId,
    checkedAt,
    status,
    cash,
    positions,
    orders,
    executions,
    intentMappings,
    issues: collectedIssues,
    summary: {
      cashStatus: cash.status,
      positionCount: positions.length,
      orderCount: orders.length,
      executionCount: executions.length,
      intentMappingCount: intentMappings.length,
      issueCount: collectedIssues.length,
      criticalIssueCount: collectedIssues.filter((issue) => issue.severity === "critical").length,
    },
    requiresManualReview: status !== "matched",
    metadata: sanitizeMetadata(input.metadata ?? {}),
  });
}

function parseSnapshot(snapshot: ReconciliationSnapshot): ParsedReconciliationSnapshot {
  return {
    account: snapshot.account === undefined ? undefined : accountSchema.parse(snapshot.account),
    positions: z.array(positionSchema).parse(snapshot.positions ?? []),
    orders: z.array(orderSchema).parse(snapshot.orders ?? []),
    executions: z.array(executionReportSchema).parse(snapshot.executions ?? []),
  };
}

function compareCash(
  local: Account | undefined,
  broker: Account | undefined,
  issues: IssueCollector,
): ReconciliationCashComparison {
  if (!local || !broker) {
    issues.add({
      status: "unknown",
      scope: "cash",
      severity: "critical",
      ref: "cash",
      message: "Cash cannot be reconciled because one side is missing",
      localValue: local ? "present" : null,
      brokerValue: broker ? "present" : null,
    });

    return {
      status: "unknown",
      localAvailable: local ? roundMoney(local.cash.available) : undefined,
      brokerAvailable: broker ? roundMoney(broker.cash.available) : undefined,
      localFrozen: local ? roundMoney(local.cash.frozen) : undefined,
      brokerFrozen: broker ? roundMoney(broker.cash.frozen) : undefined,
    };
  }

  const localAvailable = roundMoney(local.cash.available);
  const brokerAvailable = roundMoney(broker.cash.available);
  const localFrozen = roundMoney(local.cash.frozen);
  const brokerFrozen = roundMoney(broker.cash.frozen);
  let status: ReconciliationStatus = "matched";

  if (localAvailable !== brokerAvailable) {
    status = "mismatch";
    issues.add({
      status,
      scope: "cash",
      severity: "critical",
      ref: "cash.available",
      field: "available",
      localValue: localAvailable,
      brokerValue: brokerAvailable,
      message: "Available cash differs between local and broker snapshots",
    });
  }

  if (localFrozen !== brokerFrozen) {
    status = "mismatch";
    issues.add({
      status,
      scope: "cash",
      severity: "critical",
      ref: "cash.frozen",
      field: "frozen",
      localValue: localFrozen,
      brokerValue: brokerFrozen,
      message: "Frozen cash differs between local and broker snapshots",
    });
  }

  return {
    status,
    localAvailable,
    brokerAvailable,
    localFrozen,
    brokerFrozen,
  };
}

function comparePositions(
  localPositions: Position[],
  brokerPositions: Position[],
  issues: IssueCollector,
): ReconciliationPositionComparison[] {
  return unionKeys(
    localPositions.map(positionKey),
    brokerPositions.map(positionKey),
  ).map((key) => {
    const local = localPositions.find((position) => positionKey(position) === key);
    const broker = brokerPositions.find((position) => positionKey(position) === key);
    const symbol = (local ?? broker)!.symbol;
    const market = (local ?? broker)!.market;
    const comparison: ReconciliationPositionComparison = {
      key,
      symbol,
      market,
      status: "matched",
      localQuantity: local?.quantity,
      brokerQuantity: broker?.quantity,
      localSellableQuantity: local ? calculateSellableQuantity(local) : undefined,
      brokerSellableQuantity: broker ? calculateSellableQuantity(broker) : undefined,
      localFrozenQuantity: local?.frozenQuantity,
      brokerFrozenQuantity: broker?.frozenQuantity,
    };

    if (!local || !broker) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "position",
        severity: "critical",
        ref: key,
        message: "Position exists on only one side of reconciliation",
        localValue: local ? "present" : null,
        brokerValue: broker ? "present" : null,
      });
      return comparison;
    }

    if (local.quantity !== broker.quantity) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "position",
        severity: "critical",
        ref: key,
        field: "quantity",
        localValue: local.quantity,
        brokerValue: broker.quantity,
        message: "Position quantity differs between local and broker snapshots",
      });
    }

    if (comparison.localSellableQuantity !== comparison.brokerSellableQuantity) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "sellable",
        severity: "critical",
        ref: key,
        field: "sellableQuantity",
        localValue: comparison.localSellableQuantity ?? null,
        brokerValue: comparison.brokerSellableQuantity ?? null,
        message: "Sellable quantity differs between local and broker snapshots",
      });
    }

    if (local.frozenQuantity !== broker.frozenQuantity) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "frozen",
        severity: "critical",
        ref: key,
        field: "frozenQuantity",
        localValue: local.frozenQuantity,
        brokerValue: broker.frozenQuantity,
        message: "Frozen position quantity differs between local and broker snapshots",
      });
    }

    return comparison;
  });
}

function compareOrders(
  localOrders: Order[],
  brokerOrders: Order[],
  issues: IssueCollector,
): ReconciliationOrderComparison[] {
  return unionKeys(
    localOrders.map((order) => order.orderId),
    brokerOrders.map((order) => order.orderId),
  ).map((orderId) => {
    const local = localOrders.find((order) => order.orderId === orderId);
    const broker = brokerOrders.find((order) => order.orderId === orderId);
    const order = local ?? broker!;
    const comparison: ReconciliationOrderComparison = {
      orderId,
      intentId: order.intentId,
      status: "matched",
      localOrderStatus: local?.status,
      brokerOrderStatus: broker?.status,
    };

    if (!local || !broker) {
      comparison.status = "unknown";
      issues.add({
        status: "unknown",
        scope: "order",
        severity: "critical",
        ref: orderId,
        message: "Order exists on only one side of reconciliation",
        localValue: local ? "present" : null,
        brokerValue: broker ? "present" : null,
      });
      return comparison;
    }

    const mismatched = [
      ["status", local.status, broker.status],
      ["side", local.side, broker.side],
      ["quantity", local.quantity, broker.quantity],
      ["limitPrice", roundPrice(local.limitPrice), roundPrice(broker.limitPrice)],
    ].find(([, left, right]) => left !== right);

    if (mismatched) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "order",
        severity: "critical",
        ref: orderId,
        field: String(mismatched[0]),
        localValue: valueOrNull(mismatched[1]),
        brokerValue: valueOrNull(mismatched[2]),
        message: "Order differs between local and broker snapshots",
      });
    }

    return comparison;
  });
}

function compareExecutions(
  localExecutions: ExecutionReport[],
  brokerExecutions: ExecutionReport[],
  issues: IssueCollector,
): ReconciliationExecutionComparison[] {
  return unionKeys(
    localExecutions.map((execution) => execution.executionId),
    brokerExecutions.map((execution) => execution.executionId),
  ).map((executionId) => {
    const local = localExecutions.find((execution) => execution.executionId === executionId);
    const broker = brokerExecutions.find((execution) => execution.executionId === executionId);
    const execution = local ?? broker!;
    const comparison: ReconciliationExecutionComparison = {
      executionId,
      orderId: execution.orderId,
      intentId: execution.intentId,
      status: "matched",
      localQuantity: local?.quantity,
      brokerQuantity: broker?.quantity,
      localPrice: local ? roundPrice(local.price) : undefined,
      brokerPrice: broker ? roundPrice(broker.price) : undefined,
    };

    if (!local || !broker) {
      comparison.status = "unknown";
      issues.add({
        status: "unknown",
        scope: "execution",
        severity: "critical",
        ref: executionId,
        message: "Execution exists on only one side of reconciliation",
        localValue: local ? "present" : null,
        brokerValue: broker ? "present" : null,
      });
      return comparison;
    }

    const mismatched = [
      ["quantity", local.quantity, broker.quantity],
      ["price", roundPrice(local.price), roundPrice(broker.price)],
      ["netAmount", roundMoney(local.netAmount), roundMoney(broker.netAmount)],
    ].find(([, left, right]) => left !== right);

    if (mismatched) {
      comparison.status = "mismatch";
      issues.add({
        status: "mismatch",
        scope: "execution",
        severity: "critical",
        ref: executionId,
        field: String(mismatched[0]),
        localValue: valueOrNull(mismatched[1]),
        brokerValue: valueOrNull(mismatched[2]),
        message: "Execution differs between local and broker snapshots",
      });
    }

    return comparison;
  });
}

function compareIntentMappings(
  localOrders: Order[],
  brokerOrders: Order[],
  issues: IssueCollector,
): ReconciliationIntentMapping[] {
  return unionKeys(
    localOrders.map((order) => order.intentId),
    brokerOrders.map((order) => order.intentId),
  ).map((intentId) => {
    const localOrderIds = localOrders
      .filter((order) => order.intentId === intentId)
      .map((order) => order.orderId);
    const brokerOrderIds = brokerOrders
      .filter((order) => order.intentId === intentId)
      .map((order) => order.orderId);
    let status: ReconciliationStatus = "matched";

    if (localOrderIds.length !== brokerOrderIds.length) {
      status = localOrderIds.length > 1 || brokerOrderIds.length > 1
        ? "needs_manual_review"
        : "unknown";
      issues.add({
        status,
        scope: "intent_mapping",
        severity: "critical",
        ref: intentId,
        field: "orderIds",
        localValue: localOrderIds,
        brokerValue: brokerOrderIds,
        message: "IntentId maps to a different number of local and broker orders",
      });
    } else if (!sameStringSet(localOrderIds, brokerOrderIds)) {
      status = "mismatch";
      issues.add({
        status,
        scope: "intent_mapping",
        severity: "critical",
        ref: intentId,
        field: "orderIds",
        localValue: localOrderIds,
        brokerValue: brokerOrderIds,
        message: "IntentId maps to different local and broker order ids",
      });
    }

    return {
      intentId,
      status,
      localOrderIds,
      brokerOrderIds,
    };
  });
}

interface IssueInput {
  status: ReconciliationStatus;
  scope: ReconciliationScope;
  severity: ReconciliationSeverity;
  ref: string;
  field?: string;
  localValue?: unknown;
  brokerValue?: unknown;
  message: string;
  metadata?: Record<string, unknown>;
}

interface IssueCollector {
  add: (issue: IssueInput) => void;
  items: () => ReconciliationIssue[];
}

function issueCollector(reconciliationId: string): IssueCollector {
  const issues: ReconciliationIssue[] = [];

  return {
    add(issue) {
      issues.push(reconciliationIssueSchema.parse({
        issueId: `${safeIdentifier(reconciliationId, 48)}-issue-${String(issues.length + 1).padStart(3, "0")}`,
        ...issue,
        localValue: issue.localValue === undefined ? undefined : valueOrNull(issue.localValue),
        brokerValue: issue.brokerValue === undefined ? undefined : valueOrNull(issue.brokerValue),
        metadata: sanitizeMetadata(issue.metadata ?? {}),
      }));
    },
    items() {
      return [...issues];
    },
  };
}

function aggregateStatus(statuses: ReconciliationStatus[]): ReconciliationStatus {
  if (statuses.includes("mismatch")) {
    return "mismatch";
  }

  if (statuses.includes("needs_manual_review")) {
    return "needs_manual_review";
  }

  if (statuses.includes("unknown")) {
    return "unknown";
  }

  return "matched";
}

function positionKey(position: Position): string {
  return `${position.market}:${position.symbol}`;
}

function unionKeys(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function defaultReconciliationId(accountId: string, checkedAt: string): string {
  return safeIdentifier(
    `reconciliation-${accountId}-${checkedAt.replace(/\D/g, "").slice(0, 14)}`,
    128,
  );
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function valueOrNull(value: unknown): unknown {
  return value === undefined ? null : value;
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = sanitizeUnknown(child);
  }

  return output;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeUnknown);
  }

  if (typeof value === "object" && value !== null) {
    return sanitizeMetadata(value as Record<string, unknown>);
  }

  return null;
}
