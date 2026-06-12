import {
  calculateCashSummary,
  calculateMarketValue,
  roundMoney,
  roundRatio,
  type Account,
  type Position,
} from "../portfolio/index.js";
import type { Order } from "../trading/index.js";

export type RiskDecision = "passed" | "warning" | "rejected";
export type RiskSeverity = "info" | "warning" | "critical";

export type RiskViolationCode =
  | "position_limit_exceeded"
  | "hard_stop_loss"
  | "daily_loss_limit_exceeded"
  | "no_buy_active"
  | "circuit_breaker_active";

export interface RiskViolation {
  code: RiskViolationCode;
  severity: RiskSeverity;
  message: string;
  blocking: boolean;
  symbol?: string;
  threshold?: number;
  value?: number;
}

export interface RiskCheckResult {
  decision: RiskDecision;
  severity: RiskSeverity;
  violations: RiskViolation[];
  blockingViolations: RiskViolation[];
  requiresManualConfirmation: boolean;
}

export interface DailyLossState {
  baselineAssets?: number;
  currentAssets?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  totalPnl?: number;
  lossRatio?: number;
}

export interface RiskRuntimeState {
  noBuy?: boolean;
  noBuyReason?: string;
  circuitBreaker?: boolean;
  circuitBreakerReason?: string;
}

export interface RiskEngineOptions {
  maxSinglePositionRatio?: number;
  hardStopLossRatio?: number;
  dailyLossLimitRatio?: number;
  estimatedFees?: number;
  estimatedTax?: number;
  prices?: Record<string, number>;
}

export interface RiskCheckInput {
  account: Account;
  positions: Position[];
  order?: Order;
  dailyLoss?: DailyLossState;
  runtimeState?: RiskRuntimeState;
  options?: RiskEngineOptions;
}

export class RiskEngine {
  check(input: RiskCheckInput): RiskCheckResult {
    const options = normalizeRiskOptions(input.options);
    const violations: RiskViolation[] = [
      ...this.checkRuntimeState(input),
      ...this.checkDailyLoss(input, options),
      ...this.checkHardStopLoss(input.positions, options),
      ...this.checkPositionLimit(input, options),
    ];
    const blockingViolations = violations.filter((violation) => violation.blocking);

    return {
      decision:
        blockingViolations.length > 0
          ? "rejected"
          : violations.length > 0
            ? "warning"
            : "passed",
      severity: maxSeverity(violations),
      violations,
      blockingViolations,
      requiresManualConfirmation: violations.some((violation) => violation.severity === "critical"),
    };
  }

  private checkRuntimeState(input: RiskCheckInput): RiskViolation[] {
    if (input.order?.side !== "BUY") {
      return [];
    }

    const violations: RiskViolation[] = [];

    if (input.runtimeState?.noBuy) {
      violations.push({
        code: "no_buy_active",
        severity: "critical",
        message: input.runtimeState.noBuyReason ?? "No-buy state is active",
        blocking: true,
      });
    }

    if (input.runtimeState?.circuitBreaker) {
      violations.push({
        code: "circuit_breaker_active",
        severity: "critical",
        message: input.runtimeState.circuitBreakerReason ?? "Circuit breaker is active",
        blocking: true,
      });
    }

    return violations;
  }

  private checkDailyLoss(
    input: RiskCheckInput,
    options: Required<RiskEngineOptions>,
  ): RiskViolation[] {
    if (input.order?.side !== "BUY" || input.dailyLoss === undefined) {
      return [];
    }

    const lossRatio = calculateDailyLossRatio(input.dailyLoss);

    if (lossRatio < options.dailyLossLimitRatio) {
      return [];
    }

    return [
      {
        code: "daily_loss_limit_exceeded",
        severity: "critical",
        message: `Daily loss ratio ${lossRatio} reached limit ${options.dailyLossLimitRatio}`,
        blocking: true,
        threshold: options.dailyLossLimitRatio,
        value: lossRatio,
      },
    ];
  }

  private checkHardStopLoss(
    positions: Position[],
    options: Required<RiskEngineOptions>,
  ): RiskViolation[] {
    return positions.flatMap((position) => {
      if (position.quantity <= 0 || position.costPrice <= 0) {
        return [];
      }

      const latestPrice = latestPriceFor(position, options);
      const lossRatio = roundRatio((position.costPrice - latestPrice) / position.costPrice);

      if (lossRatio < options.hardStopLossRatio) {
        return [];
      }

      return [
        {
          code: "hard_stop_loss",
          severity: "critical",
          message: `${position.symbol} loss ratio ${lossRatio} reached stop-loss ${options.hardStopLossRatio}`,
          blocking: false,
          symbol: position.symbol,
          threshold: options.hardStopLossRatio,
          value: lossRatio,
        },
      ];
    });
  }

  private checkPositionLimit(
    input: RiskCheckInput,
    options: Required<RiskEngineOptions>,
  ): RiskViolation[] {
    if (input.order?.side !== "BUY") {
      return [];
    }

    const projection = projectBuyPositionRatio(input.account, input.positions, input.order, options);

    if (projection.positionRatio <= options.maxSinglePositionRatio) {
      return [];
    }

    return [
      {
        code: "position_limit_exceeded",
        severity: "critical",
        message: `${input.order.symbol} projected position ratio ${projection.positionRatio} exceeds limit ${options.maxSinglePositionRatio}`,
        blocking: true,
        symbol: input.order.symbol,
        threshold: options.maxSinglePositionRatio,
        value: projection.positionRatio,
      },
    ];
  }
}

export function checkRisk(input: RiskCheckInput): RiskCheckResult {
  return new RiskEngine().check(input);
}

export function calculateDailyLossRatio(state: DailyLossState): number {
  if (state.lossRatio !== undefined) {
    return roundRatio(Math.max(0, state.lossRatio));
  }

  if (
    state.baselineAssets !== undefined &&
    state.currentAssets !== undefined &&
    state.baselineAssets > 0
  ) {
    return roundRatio(Math.max(0, (state.baselineAssets - state.currentAssets) / state.baselineAssets));
  }

  const totalPnl = state.totalPnl ?? (state.realizedPnl ?? 0) + (state.unrealizedPnl ?? 0);

  if (state.baselineAssets !== undefined && state.baselineAssets > 0 && totalPnl < 0) {
    return roundRatio(Math.abs(totalPnl) / state.baselineAssets);
  }

  return 0;
}

function projectBuyPositionRatio(
  account: Account,
  positions: Position[],
  order: Order,
  options: Required<RiskEngineOptions>,
): { positionRatio: number; projectedTotalAssets: number; projectedPositionMarketValue: number } {
  const cash = calculateCashSummary(account);
  const requiredCash = roundMoney(order.quantity * order.limitPrice + options.estimatedFees + options.estimatedTax);
  const projectedCashTotal = roundMoney(cash.total - requiredCash);
  let projectedPositionMarketValue = 0;
  let projectedAllPositionsMarketValue = 0;
  let targetMatched = false;

  for (const position of positions) {
    const isTarget =
      position.accountId === order.accountId &&
      position.symbol === order.symbol &&
      position.market === order.market;
    const marketValue = isTarget
      ? roundMoney((position.quantity + order.quantity) * order.limitPrice)
      : calculateMarketValue(position, latestPriceFor(position, options));

    projectedAllPositionsMarketValue = roundMoney(projectedAllPositionsMarketValue + marketValue);

    if (isTarget) {
      projectedPositionMarketValue = marketValue;
      targetMatched = true;
    }
  }

  if (!targetMatched) {
    projectedPositionMarketValue = roundMoney(order.quantity * order.limitPrice);
    projectedAllPositionsMarketValue = roundMoney(
      projectedAllPositionsMarketValue + projectedPositionMarketValue,
    );
  }

  const projectedTotalAssets = roundMoney(projectedCashTotal + projectedAllPositionsMarketValue);

  return {
    projectedPositionMarketValue,
    projectedTotalAssets,
    positionRatio:
      projectedTotalAssets > 0
        ? roundRatio(projectedPositionMarketValue / projectedTotalAssets)
        : 1,
  };
}

function latestPriceFor(position: Position, options: Required<RiskEngineOptions>): number {
  return options.prices[position.symbol] ?? position.latestPrice ?? position.costPrice;
}

function normalizeRiskOptions(options: RiskEngineOptions = {}): Required<RiskEngineOptions> {
  const normalized = {
    maxSinglePositionRatio: options.maxSinglePositionRatio ?? 0.4,
    hardStopLossRatio: options.hardStopLossRatio ?? 0.08,
    dailyLossLimitRatio: options.dailyLossLimitRatio ?? 0.03,
    estimatedFees: options.estimatedFees ?? 0,
    estimatedTax: options.estimatedTax ?? 0,
    prices: options.prices ?? {},
  };

  assertRatio(normalized.maxSinglePositionRatio, "maxSinglePositionRatio");
  assertRatio(normalized.hardStopLossRatio, "hardStopLossRatio");
  assertRatio(normalized.dailyLossLimitRatio, "dailyLossLimitRatio");

  return normalized;
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RiskEngineError(`${name} must be between 0 and 1`);
  }
}

function maxSeverity(violations: RiskViolation[]): RiskSeverity {
  if (violations.some((violation) => violation.severity === "critical")) {
    return "critical";
  }

  if (violations.some((violation) => violation.severity === "warning")) {
    return "warning";
  }

  return "info";
}

export class RiskEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiskEngineError";
  }
}

