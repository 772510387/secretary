import type { AppConfig } from "../config/index.js";
import { tradeIntentReviewProposalSchema } from "../domain/memory/index.js";
import {
  executePendingOrder,
  type ExecutePendingOrderDeps,
  type ExecutePendingOrderInput,
  type ExecutePendingOrderResult,
} from "./execute-pending-order.js";
import {
  inferMarket,
  type AuctionBoardToolQuery,
  type FeedbackAuditToolQuery,
  type FeedbackAuditToolResult,
  type MarketOverviewToolResult,
  type PaperAgentToolDeps,
  type PaperOrderOutcome,
  type PaperOrderRequest,
  type PaperPortfolioView,
  type PaperQuoteView,
  type PaperTechnicalView,
  type StrategyKnowledgeToolQuery,
  type StrategyKnowledgeToolResult,
  type WatchlistToolQuery,
  type WatchlistToolResult,
} from "./brain-agent-tools.js";
import { rememberModelNote, searchModelMemory } from "./model-memory.js";
import { buildOperationReviewContext, type OperationReviewToolQuery, type OperationReviewToolResult } from "./operation-review-context.js";
import { beijingDate } from "./paper-ops-intent.js";
import { buildProblemFeedbackFactPack } from "./problem-feedback.js";
import {
  buildStrategyKnowledgeDigest,
  renderStrategyKnowledgeDigest,
} from "./strategy-knowledge.js";

/**
 * Wires the paper agent tools to the REAL deterministic hand (executePendingOrder).
 *
 * The model only "下达购买意图" via a tool call; this turns that intent into a
 * review-required proposal and runs it through the proven paper path (RiskEngine →
 * PaperBroker → ledger write) under reviewer "auto-paper". Sizing/T+1/lot/cash are all
 * enforced there — the model has no sizing authority and never touches a real broker.
 *
 * `executeOrder` is an injectable seam (defaults to executePendingOrder) so this is
 * unit-testable without a live broker.
 */
export interface PaperAgentToolWiring {
  config: AppConfig;
  memoryDir: string;
  /** The "eye" over the ledger — usually built from the PaperBroker valuation. */
  loadPortfolioView: () => PaperPortfolioView | Promise<PaperPortfolioView>;
  /** Latest price for sizing + as the fill limit when the model gives none. */
  getLatestPrice: (symbol: string) => number | null | Promise<number | null>;
  getMarketOverview?: () => MarketOverviewToolResult | Promise<MarketOverviewToolResult>;
  queryWatchlist?: (query: WatchlistToolQuery) => WatchlistToolResult | Promise<WatchlistToolResult>;
  getAuctionBoard?: (query: AuctionBoardToolQuery) => WatchlistToolResult | Promise<WatchlistToolResult>;
  getQuote?: (symbol: string) => PaperQuoteView | null | Promise<PaperQuoteView | null>;
  getTechnicals?: (symbol: string) => PaperTechnicalView | null | Promise<PaperTechnicalView | null>;
  getStrategyKnowledge?: (
    query: StrategyKnowledgeToolQuery,
  ) => StrategyKnowledgeToolResult | Promise<StrategyKnowledgeToolResult>;
  getOperationReview?: (query: OperationReviewToolQuery) => OperationReviewToolResult | Promise<OperationReviewToolResult>;
  getFeedbackAudit?: (query: FeedbackAuditToolQuery) => FeedbackAuditToolResult | Promise<FeedbackAuditToolResult>;
  now?: () => Date;
  /** Seam for the deterministic hand; defaults to the real executePendingOrder. */
  executeOrder?: (input: ExecutePendingOrderInput, deps: ExecutePendingOrderDeps) => ExecutePendingOrderResult;
}

/** Per-turn cap on guarded memory writes so a runaway loop can't spam long-term memory. */
const MAX_MEMORY_WRITES_PER_TURN = 5;

export function buildPaperAgentToolDeps(wiring: PaperAgentToolWiring): PaperAgentToolDeps {
  const now = wiring.now ?? (() => new Date());
  const executeOrder = wiring.executeOrder ?? executePendingOrder;
  let seq = 0;
  let memoryWrites = 0;

  const executePaperOrder = async (order: PaperOrderRequest): Promise<PaperOrderOutcome> => {
    const latestPrice = order.limitPrice ?? (await wiring.getLatestPrice(order.symbol)) ?? 0;
    if (latestPrice <= 0) {
      return { status: "skipped", reason: "no_price" };
    }

    seq += 1;
    const stamp = now().getTime();
    const proposalId = `brain-agent-${order.side}-${order.symbol}-${stamp}-${seq}`.slice(0, 128);
    const proposal = tradeIntentReviewProposalSchema.parse({
      proposalId,
      proposalType: "trade_intent_review",
      status: "pending_review",
      source: { sourceType: "brain_tool_request", requestId: proposalId, toolType: "propose_trade_intent" },
      symbol: order.symbol,
      market: order.market ?? inferMarket(order.symbol),
      name: order.name,
      side: order.side,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      currency: "CNY",
      rationale: order.reason,
      reviewReason: `Brain agent ${order.side} ${order.symbol}（模拟盘自动执行）`,
      executionGuard: {
        requiresManualReview: true,
        executable: false,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      createdBy: { type: "system", id: "brain-agent" },
      metadata: { liveTrading: false, directExecutionAllowed: false },
    });

    const result = executeOrder(
      { proposal, latestPrice, reviewer: "auto-paper", now: now() },
      { config: wiring.config, memoryDir: wiring.memoryDir },
    );

    return toOutcome(result);
  };

  return {
    loadPortfolio: wiring.loadPortfolioView,
    getMarketOverview: wiring.getMarketOverview,
    queryWatchlist: wiring.queryWatchlist,
    getAuctionBoard: wiring.getAuctionBoard,
    getQuote: wiring.getQuote,
    getTechnicals: wiring.getTechnicals,
    getStrategyKnowledge:
      wiring.getStrategyKnowledge ??
      ((query) => buildDefaultStrategyKnowledgeResult(wiring.memoryDir, query, now())),
    getOperationReview:
      wiring.getOperationReview ??
      ((query) => {
        const current = now();
        return {
          ok: true,
          review: buildOperationReviewContext({
            memoryDir: wiring.memoryDir,
            tradingDate: query.tradingDate ?? beijingDate(current),
            symbol: query.symbol,
            now: current,
          }),
        };
      }),
    getFeedbackAudit:
      wiring.getFeedbackAudit ??
      ((query) =>
        buildProblemFeedbackFactPack({
          memoryDir: wiring.memoryDir,
          query: query.query,
          from: query.from,
          to: query.to,
          now: now(),
        }) as unknown as FeedbackAuditToolResult),
    executePaperOrder,
    // MEM-05/07: read + guarded-write memory tools, wired straight from the memory dir.
    searchMemory: (query) =>
      searchModelMemory({
        memoryDir: wiring.memoryDir,
        query: query.query,
        from: query.from,
        to: query.to,
        limit: query.limit,
      }),
    rememberNote: (note) => {
      if (memoryWrites >= MAX_MEMORY_WRITES_PER_TURN) {
        return { ok: false, reason: "memory_write_rate_limit" };
      }
      memoryWrites += 1;
      return rememberModelNote({
        memoryDir: wiring.memoryDir,
        note: note.note,
        tags: note.tags,
        kind: note.kind,
        now: now(),
      });
    },
  };
}

function buildDefaultStrategyKnowledgeResult(
  memoryDir: string,
  query: StrategyKnowledgeToolQuery,
  now: Date,
): StrategyKnowledgeToolResult {
  const digest = buildStrategyKnowledgeDigest({
    memoryDir,
    focusStrategyId: query.strategyId,
    maxCases: query.maxCases,
    asOfDate: now.toISOString().slice(0, 10),
  });
  return {
    ok: true,
    summaryText: renderStrategyKnowledgeDigest(digest),
    strategyCount: digest.strategies.length,
    caseCount: digest.cases.length,
    decisionCount: digest.decisions.length,
    strategies: digest.strategies.map((strategy) => ({
      strategyId: strategy.strategyId,
      name: strategy.name,
      category: strategy.category,
      status: strategy.status,
      sampleSize: strategy.metrics.sampleSize,
      hitRate: strategy.metrics.hitRate,
      avgForwardReturn: strategy.metrics.avgForwardReturn,
      lifecycleSuggestion: strategy.metrics.lifecycleSuggestion,
    })),
    cases: digest.cases.map((item) => ({
      caseId: item.caseId,
      strategyId: item.strategyId,
      date: item.date,
      symbol: item.symbol,
      name: item.name,
      action: item.action,
      outcome: item.outcome,
      forwardReturn: item.forwardReturn,
    })),
    notes: digest.notes,
  };
}

function toOutcome(result: ExecutePendingOrderResult): PaperOrderOutcome {
  return {
    status: result.status,
    reason: result.reason,
    quantity: result.quantity,
    limitPrice: result.limitPrice,
    idempotent: result.idempotent,
  };
}
