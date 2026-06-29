import { isLiveTradingEnabled, type AppConfig } from "../config/index.js";
import {
  calculatePortfolioValuation,
  type Account,
  type Position,
} from "../domain/portfolio/index.js";
import { RiskEngine } from "../domain/risk/index.js";
import { createOrderFromIntent, tradeIntentSchema, type TradeIntent } from "../domain/trading/index.js";
import type { TradeIntentReviewProposal } from "../domain/memory/index.js";
import { PaperBroker } from "../infrastructure/broker/index.js";

export type PendingOrderReviewer = "user" | "auto-paper";

export interface ExecutePendingOrderInput {
  /** A review-required BUY/SELL proposal (directional; quantity/price are sized here, not by the model). */
  proposal: TradeIntentReviewProposal;
  /** Current price used to size the order and as the limit price. */
  latestPrice: number;
  /**
   * Who is authorizing the fill: a human Feishu confirmation ("user"), or the
   * operator-enabled paper auto-fill ("auto-paper"). BOTH are paper-only; the model
   * itself never reaches this function.
   */
  reviewer: PendingOrderReviewer;
  now?: Date;
  /** Fraction of available cash a single BUY may use (default 0.95). */
  cashFraction?: number;
}

export interface ExecutePendingOrderDeps {
  config: AppConfig;
  memoryDir: string;
  /** Inject a broker (tests); otherwise a PaperBroker over memoryDir is created. */
  broker?: PaperBroker;
  riskEngine?: RiskEngine;
}

export interface ExecutePendingOrderResult {
  status: "filled" | "rejected" | "blocked" | "skipped";
  reason?: string;
  intentId: string;
  quantity?: number;
  limitPrice?: number;
  idempotent?: boolean;
}

/**
 * Executes ONE review-required trade proposal against the PAPER simulation, mirroring the
 * proven `trade.ts` flow (RiskEngine pre-check → PaperBroker fill → portfolio write).
 *
 * RED LINES (the funnel's only execution path):
 *  - HARD paper-only gate: refuses unless liveTrading is off AND trading.mode==='paper' AND
 *    broker.provider==='paper' AND account.type==='paper'. Throws (never silently downgrades).
 *  - The MODEL never calls this — only a human Feishu confirm ("user") or the operator's
 *    explicit `--auto-paper` simulation flag ("auto-paper") does; both are still paper-gated.
 *  - Quantity/price are sized deterministically here under RiskEngine + PaperBroker (single-
 *    position cap, 100-lot, cash, T+1) — the model has no sizing authority.
 *  - Idempotent: the intentId is derived from the proposalId, so a re-confirm cannot double-fill.
 */
export function executePendingOrder(
  input: ExecutePendingOrderInput,
  deps: ExecutePendingOrderDeps,
): ExecutePendingOrderResult {
  const now = input.now ?? new Date();
  const intentId = `intent-${input.proposal.proposalId}`.slice(0, 128);
  const side = input.proposal.side;

  if (side !== "BUY" && side !== "SELL") {
    return { status: "skipped", reason: `unsupported_proposal_side:${side}`, intentId };
  }

  // The fill is stamped with `now` (the simulated node instant during a replay/simulate),
  // not the wall clock — otherwise a replay of 10:30 fills shows the evening run-time
  // (e.g. 17:47), an impossible A-share trading time.
  const broker =
    deps.broker ?? new PaperBroker({ memoryDir: deps.memoryDir, t1Enabled: deps.config.trading.t1Enabled, now: () => now });
  const account = broker.getAccount();
  const positions = broker.getPositions();

  // HARD paper-only gate (defensive — also checked once up front by the caller).
  assertPaperOnly(deps.config, account);

  // Idempotency BEFORE sizing/risk: if this proposal already produced a fill (same
  // deterministic intentId), return it — a re-confirm must never re-size or double-fill.
  const existingTrade = broker.getTrades().find((trade) => trade.intentId === intentId);
  if (existingTrade !== undefined) {
    return {
      status: "filled",
      intentId,
      quantity: existingTrade.quantity,
      limitPrice: existingTrade.price,
      idempotent: true,
    };
  }

  const limitPrice = input.proposal.limitPrice ?? input.latestPrice;
  if (limitPrice <= 0) {
    return { status: "skipped", reason: "invalid_price", intentId };
  }

  const quantity =
    input.proposal.quantity ??
    (side === "BUY"
      ? sizeBuyQuantity(account, positions, input.proposal.symbol, limitPrice, deps.config, input.cashFraction ?? 0.95)
      : sizeSellQuantity(account, positions, input.proposal.symbol, limitPrice, deps.config.trading.t1Enabled));

  if (quantity <= 0 || (side === "BUY" && quantity < deps.config.trading.lotSize)) {
    return {
      status: "skipped",
      reason: side === "BUY" ? "insufficient_cash_or_lot" : "no_sellable_quantity",
      intentId,
    };
  }
  if (side === "BUY" && quantity % deps.config.trading.lotSize !== 0) {
    return { status: "skipped", reason: "invalid_lot_size", intentId, quantity, limitPrice };
  }

  const intent: TradeIntent = tradeIntentSchema.parse({
    intentId,
    accountId: account.accountId,
    symbol: input.proposal.symbol,
    market: input.proposal.market,
    name: input.proposal.name,
    side,
    quantity,
    limitPrice,
    currency: "CNY",
    source: input.reviewer === "user" ? "user" : "system",
    reason: `funnel proposal ${input.proposal.proposalId} (${input.reviewer})`.slice(0, 1000),
    createdAt: now.toISOString(),
  });

  if (side === "BUY") {
    const risk = (deps.riskEngine ?? new RiskEngine()).check({
      account,
      positions,
      order: createOrderFromIntent({ orderId: `order-precheck-${intentId}`, intent, now }),
      options: {
        maxSinglePositionRatio: deps.config.risk.maxSinglePositionRatio,
        hardStopLossRatio: deps.config.risk.hardStopLossRatio,
        dailyLossLimitRatio: deps.config.risk.dailyLossLimitRatio,
        prices: { [intent.symbol]: limitPrice },
      },
    });
    if (risk.decision === "rejected") {
      return {
        status: "blocked",
        reason: `risk:${risk.blockingViolations.map((v) => v.code).join(",") || "rejected"}`,
        intentId,
        quantity,
        limitPrice,
      };
    }
  }

  const result = broker.submitOrder(intent);
  if (result.order.status === "rejected") {
    return {
      status: "rejected",
      reason: `broker:${result.order.rejectReason?.code ?? "rejected"}`,
      intentId,
      quantity,
      limitPrice,
      idempotent: result.idempotent,
    };
  }

  return {
    status: "filled",
    intentId,
    quantity,
    limitPrice,
    idempotent: result.idempotent,
  };
}

export interface ExecutePaperStopLossInput {
  symbol: string;
  market: "SSE" | "SZSE";
  name?: string;
  /** Current price (from the sentinel) used to size the close and as the limit price. */
  latestPrice: number;
  now?: Date;
  reason?: string;
}

/**
 * 8% 硬止损强制平仓 (PAPER only) — the deterministic risk hand.
 *
 * When the 3-second sentinel detects a holding below the hard stop-loss line, this closes the
 * FULL sellable quantity in the PAPER simulation with NO model and NO confirmation (per the
 * "8% 物理硬止损，无条件强行平仓" constitution + the user's paper-auto-execute decision).
 *
 * RED LINES: hard paper-only gate (refuses any live/non-paper config, throws — never live);
 * idempotent per symbol+day (a re-fire within the day cannot double-sell); T+1 / sellable-
 * quantity still enforced by the PaperBroker (a same-day buy can't be force-sold).
 */
export function executePaperStopLoss(
  input: ExecutePaperStopLossInput,
  deps: ExecutePendingOrderDeps,
): ExecutePendingOrderResult {
  const now = input.now ?? new Date();
  const intentId = `intent-stoploss-${input.symbol}-${now.toISOString().slice(0, 10)}`.slice(0, 128);

  const broker =
    deps.broker ?? new PaperBroker({ memoryDir: deps.memoryDir, t1Enabled: deps.config.trading.t1Enabled });
  const account = broker.getAccount();
  const positions = broker.getPositions();

  // HARD paper-only gate — a live config can never force-close through this path.
  assertPaperOnly(deps.config, account);

  const existingTrade = broker.getTrades().find((trade) => trade.intentId === intentId);
  if (existingTrade !== undefined) {
    return {
      status: "filled",
      intentId,
      quantity: existingTrade.quantity,
      limitPrice: existingTrade.price,
      idempotent: true,
    };
  }

  if (input.latestPrice <= 0) {
    return { status: "skipped", reason: "invalid_price", intentId };
  }

  const quantity = sizeSellQuantity(account, positions, input.symbol, input.latestPrice, deps.config.trading.t1Enabled);
  if (quantity <= 0) {
    // Nothing sellable (e.g. a same-day buy still under T+1) — leave it to the sentinel alert.
    return { status: "skipped", reason: "no_sellable_quantity", intentId };
  }

  const intent: TradeIntent = tradeIntentSchema.parse({
    intentId,
    accountId: account.accountId,
    symbol: input.symbol,
    market: input.market,
    name: input.name,
    side: "SELL",
    quantity,
    limitPrice: input.latestPrice,
    currency: "CNY",
    source: "system",
    reason: (input.reason ?? "8% 硬止损强制平仓（自动，仅模拟盘）").slice(0, 1000),
    createdAt: now.toISOString(),
  });

  const result = broker.submitOrder(intent);
  if (result.order.status === "rejected") {
    return {
      status: "rejected",
      reason: `broker:${result.order.rejectReason?.code ?? "rejected"}`,
      intentId,
      quantity,
      limitPrice: input.latestPrice,
      idempotent: result.idempotent,
    };
  }

  return {
    status: "filled",
    intentId,
    quantity,
    limitPrice: input.latestPrice,
    idempotent: result.idempotent,
  };
}

/**
 * The funnel may ONLY ever touch a paper simulation. Refuses loudly on anything else so a
 * mis-typed account or a live-mode config can never reach a broker through this path.
 */
export function assertPaperOnly(config: AppConfig, account: Account): void {
  if (isLiveTradingEnabled(config) || config.runtime.liveTrading === true) {
    throw new PaperExecutionError("拒绝执行：实盘交易已启用，选股漏斗仅限模拟盘。");
  }
  if (config.trading.mode !== "paper") {
    throw new PaperExecutionError(`拒绝执行：trading.mode=${config.trading.mode}，仅允许 paper。`);
  }
  if (config.broker.provider !== "paper") {
    throw new PaperExecutionError(`拒绝执行：broker.provider=${config.broker.provider}，仅允许 paper。`);
  }
  if (account.type !== "paper") {
    throw new PaperExecutionError(`拒绝执行：账户类型=${account.type}，仅允许 paper 账户。`);
  }
}

function sizeBuyQuantity(
  account: Account,
  positions: Position[],
  symbol: string,
  price: number,
  config: AppConfig,
  cashFraction: number,
): number {
  const valuation = calculatePortfolioValuation(account, positions, { prices: { [symbol]: price } });
  const byRatio = valuation.totalAssets * config.risk.maxSinglePositionRatio;
  const byCash = account.cash.available * cashFraction;
  const budget = Math.min(byRatio, byCash);
  const lots = Math.floor(budget / (price * 100));
  return Math.max(0, lots) * 100;
}

function sizeSellQuantity(
  account: Account,
  positions: Position[],
  symbol: string,
  price: number,
  t1Enabled: boolean,
): number {
  const valuation = calculatePortfolioValuation(account, positions, {
    prices: { [symbol]: price },
    t1Enabled,
  });
  const held = valuation.positions.find((position) => position.symbol === symbol);
  return held ? held.sellableQuantity : 0;
}

export class PaperExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperExecutionError";
  }
}
