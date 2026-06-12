import {
  calculateSellableQuantity,
  roundMoney,
  type Account,
  type Position,
} from "../portfolio/index.js";
import type { Order, OrderRejectReason } from "../trading/index.js";

export type PolicyDecision = "passed" | "rejected";

export type PolicyRejectCode =
  | "account_mismatch"
  | "account_not_active"
  | "non_main_board"
  | "invalid_lot_size"
  | "insufficient_cash"
  | "position_not_found"
  | "insufficient_sellable_quantity";

export interface PolicyRejectReason extends OrderRejectReason {
  code: PolicyRejectCode;
}

export interface PolicyCheckResult {
  decision: PolicyDecision;
  reason?: PolicyRejectReason;
}

export interface PolicyEngineOptions {
  mainBoardOnly?: boolean;
  lotSize?: number;
  t1Enabled?: boolean;
  estimatedFees?: number;
  estimatedTax?: number;
}

export interface PolicyCheckInput {
  order: Order;
  account: Account;
  positions: Position[];
  options?: PolicyEngineOptions;
}

export class PolicyEngine {
  checkOrder(input: PolicyCheckInput): PolicyCheckResult {
    const options = normalizeOptions(input.options);
    const accountCheck = checkAccount(input.order, input.account);

    if (accountCheck.decision === "rejected") {
      return accountCheck;
    }

    if (options.mainBoardOnly && !isMainBoardSymbol(input.order.symbol, input.order.market)) {
      return reject("non_main_board", `${input.order.symbol} is not allowed by main-board-only policy`);
    }

    if (input.order.side === "BUY") {
      return this.checkBuy(input, options);
    }

    return this.checkSell(input, options);
  }

  private checkBuy(input: PolicyCheckInput, options: Required<PolicyEngineOptions>): PolicyCheckResult {
    if (input.order.quantity % options.lotSize !== 0) {
      return reject(
        "invalid_lot_size",
        `Buy quantity ${input.order.quantity} must be a multiple of ${options.lotSize}`,
      );
    }

    const requiredCash = calculateRequiredCash(input.order, options);

    if (input.account.cash.available < requiredCash) {
      return reject(
        "insufficient_cash",
        `Available cash ${input.account.cash.available} is less than required ${requiredCash}`,
      );
    }

    return pass();
  }

  private checkSell(input: PolicyCheckInput, options: Required<PolicyEngineOptions>): PolicyCheckResult {
    const position = findPosition(input.order, input.positions);

    if (!position) {
      return reject("position_not_found", `No position found for ${input.order.symbol}`);
    }

    const sellableQuantity = calculateSellableQuantity(position, {
      t1Enabled: options.t1Enabled,
    });

    if (input.order.quantity > sellableQuantity) {
      return reject(
        "insufficient_sellable_quantity",
        `Sell quantity ${input.order.quantity} exceeds sellable quantity ${sellableQuantity}`,
      );
    }

    return pass();
  }
}

export function checkOrderPolicy(input: PolicyCheckInput): PolicyCheckResult {
  return new PolicyEngine().checkOrder(input);
}

export function isMainBoardSymbol(symbol: string, market: Position["market"]): boolean {
  if (market === "SSE") {
    return /^(600|601|603|605)\d{3}$/.test(symbol);
  }

  if (market === "SZSE") {
    return /^(000|001|002|003)\d{3}$/.test(symbol);
  }

  return false;
}

function checkAccount(order: Order, account: Account): PolicyCheckResult {
  if (order.accountId !== account.accountId) {
    return reject(
      "account_mismatch",
      `Order account ${order.accountId} does not match account ${account.accountId}`,
    );
  }

  if (account.status !== "active") {
    return reject("account_not_active", `Account ${account.accountId} is not active`);
  }

  return pass();
}

function calculateRequiredCash(order: Order, options: Required<PolicyEngineOptions>): number {
  return roundMoney(order.quantity * order.limitPrice + options.estimatedFees + options.estimatedTax);
}

function findPosition(order: Order, positions: Position[]): Position | undefined {
  return positions.find(
    (position) =>
      position.accountId === order.accountId &&
      position.symbol === order.symbol &&
      position.market === order.market,
  );
}

function normalizeOptions(options: PolicyEngineOptions = {}): Required<PolicyEngineOptions> {
  const lotSize = options.lotSize ?? 100;

  if (!Number.isInteger(lotSize) || lotSize <= 0) {
    throw new PolicyEngineError("lotSize must be a positive integer");
  }

  return {
    mainBoardOnly: options.mainBoardOnly !== false,
    lotSize,
    t1Enabled: options.t1Enabled !== false,
    estimatedFees: options.estimatedFees ?? 0,
    estimatedTax: options.estimatedTax ?? 0,
  };
}

function pass(): PolicyCheckResult {
  return {
    decision: "passed",
  };
}

function reject(code: PolicyRejectCode, message: string): PolicyCheckResult {
  return {
    decision: "rejected",
    reason: {
      code,
      message,
    },
  };
}

export class PolicyEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEngineError";
  }
}

