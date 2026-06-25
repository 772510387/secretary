import {
  auditEventSchema,
  type AuditEvent,
} from "../domain/audit/index.js";
import {
  brainInputSchema,
  generateBrainOutput,
  type BrainOutput,
  type BrainProvider,
  type BrainStreamProgress,
} from "../domain/brain/index.js";
import { beijingDateLabel } from "../domain/shared/index.js";
import {
  calculatePortfolioValuation,
  type Account,
  type PortfolioValuation,
  type Position,
} from "../domain/portfolio/index.js";
import type { PlanWatchlistEntry } from "../domain/plan/index.js";
import type { ThemeHeatSummary } from "../domain/market/index.js";
import type { JsonValue } from "../domain/shared/index.js";

export interface AskWebSearchContext {
  query: string;
  answer?: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}

/**
 * Explicit market-data health fed to the brain. The point: when an eye (quotes /
 * indices / watchlist) comes back empty, the brain is TOLD it is degraded so it can
 * say "数据缺失" instead of inventing numbers — the root cause of this morning's
 * hallucinated indices / prices.
 */
export interface MarketDataHealth {
  asOf: string;
  pricedSymbols: number;
  indicesCount: number;
  watchlistCount: number;
  degraded: boolean;
  notes: string[];
}

export interface AskTechnical {
  symbol: string;
  market: string;
  name?: string;
  asOfDate: string;
  trend: string;
  ma5?: number;
  ma10?: number;
  ma20?: number;
  high60: number;
  low60: number;
  rangePosition60: number;
}

export interface AskIndex {
  indexId?: string;
  name: string;
  latestPrice: number;
  changePct: number;
  asOfDate?: string;
}

export interface AskPortfolioInput {
  question: string;
  account: Account;
  positions: Position[];
  /** Latest prices by symbol for mark-to-market; omit to value at cost. */
  prices?: Record<string, number>;
  t1Enabled?: boolean;
  /** Daily technical indicators (MA / trend / 60-day range) for the held symbols. */
  technicals?: AskTechnical[];
  /** Market index snapshots (大盘) for context. */
  indices?: AskIndex[];
  /** The maintained 100 高关注池 (so the brain reasons over the real pool, not invented codes). */
  watchlist?: PlanWatchlistEntry[];
  /** Deterministic market-wide 新题材热度 (涨停家数/涨跌分布/热度) — computed by code, not the model. */
  themeHeat?: ThemeHeatSummary;
  /** Explicit data health so the model degrades honestly instead of hallucinating. */
  dataHealth?: MarketDataHealth;
  /** Optional backend-executed web search results fed to the model as context. */
  webSearch?: AskWebSearchContext;
  /** Compact recent conversation (for the model to resolve referents / follow-ups). */
  history?: string;
  requestId?: string;
  now?: string;
  metadata?: Record<string, JsonValue>;
  /** Optional external cancellation for the model call. */
  signal?: AbortSignal;
  /** Optional streaming heartbeat (chars/elapsed) as the answer accumulates. */
  onProgress?: (progress: BrainStreamProgress) => void;
}

export interface AskPortfolioDependencies {
  brainProvider: BrainProvider;
}

export interface AskPortfolioResult {
  requestId: string;
  generatedAt: string;
  question: string;
  valuation: PortfolioValuation;
  pricesAvailable: boolean;
  answer: string;
  structured: JsonValue;
  citations: BrainOutput["citations"];
  confidence: number;
  provider: string;
  model: string;
  auditEvent: AuditEvent;
  metadata: Record<string, JsonValue>;
}

/**
 * Answers a natural-language question about the current paper account using the
 * configured brain provider.
 *
 * It is read-only: it values the account from the stored DB (optionally marked
 * to market with injected prices), feeds a compact de-identified context to the
 * model, and returns the model's answer. The model cannot execute tools, place
 * orders, or write the account; any trade idea must stay a review-required
 * proposal (enforced by the BrainOutput contract and validation).
 */
export async function runAskOnce(
  input: AskPortfolioInput,
  dependencies: AskPortfolioDependencies,
): Promise<AskPortfolioResult> {
  const question = input.question.trim();

  if (!question) {
    throw new AskPortfolioError("question must not be empty");
  }

  const generatedAt = normalizeNow(input.now);
  const requestId = (input.requestId ?? `ask-${Date.parse(generatedAt)}`).slice(0, 128);
  const pricesAvailable = Boolean(input.prices && Object.keys(input.prices).length > 0);
  const valuation = calculatePortfolioValuation(input.account, input.positions, {
    prices: input.prices,
    t1Enabled: input.t1Enabled ?? true,
  });
  const webSearchUsed = Boolean(input.webSearch && input.webSearch.results.length > 0);
  const context = buildAskContext({
    valuation,
    pricesAvailable,
    asOf: generatedAt,
    technicals: input.technicals,
    indices: input.indices,
    watchlist: input.watchlist,
    themeHeat: input.themeHeat,
    dataHealth: input.dataHealth,
    webSearch: input.webSearch,
  });

  const sources = [
    "账户持仓",
    input.technicals && input.technicals.length > 0 ? "技术指标(均线/趋势/60日位置)" : undefined,
    input.indices && input.indices.length > 0 ? "大盘指数" : undefined,
    input.watchlist && input.watchlist.length > 0 ? "100支高关注池" : undefined,
    input.themeHeat ? "新题材热度(涨停家数/热度榜)" : undefined,
    webSearchUsed ? "联网检索的新闻/政策" : undefined,
  ].filter(Boolean);

  // When an eye is degraded, instruct honest degradation — never invent the missing data.
  const degradedNote =
    input.dataHealth && input.dataHealth.degraded
      ? `注意：部分数据缺失或降级（${input.dataHealth.notes.join("；") || "见 context.dataHealth"}）。请只基于已有数据分析，缺失处如实说明“数据缺失”，绝不编造价格、指数、新闻或个股。`
      : undefined;

  const brainInput = brainInputSchema.parse({
    requestId,
    taskType: "user_query",
    prompt: [
      `当前日期：${beijingDateLabel(generatedAt)}，时区 Asia/Shanghai。涉及“今天/昨天/本周/最近几天”等相对时间，以此为准换算，不要凭记忆臆测日期或年份。`,
      ...(input.history && input.history.trim()
        ? [`【最近对话，仅供理解“它/那只/再说详细点”等指代，不要照抄】\n${input.history.trim()}`, ""]
        : []),
      question,
      "",
      `请用简体中文回答，结合提供的${sources.join("、")}做分析。`,
      ...(degradedNote ? [degradedNote] : []),
      "给出趋势研判和下一步操作思路即可（模拟盘账户）。",
    ].join("\n"),
    context,
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      toolPermissions: [],
    },
    createdAt: generatedAt,
  });

  const output = await generateBrainOutput(dependencies.brainProvider, brainInput, {
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const auditEvent = buildAskAudit({
    requestId,
    generatedAt,
    account: input.account,
    valuation,
    provider: output.provider,
    pricesAvailable,
  });

  return {
    requestId,
    generatedAt,
    question,
    valuation,
    pricesAvailable,
    answer: output.summary,
    structured: output.structured,
    citations: output.citations,
    confidence: output.confidence,
    provider: output.provider,
    model: output.model,
    auditEvent,
    metadata: {
      ...input.metadata,
      provider: output.provider,
      model: output.model,
      pricesAvailable,
      positionCount: input.positions.length,
      webSearchUsed,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  };
}

export interface BuildAskContextInput {
  valuation: PortfolioValuation;
  pricesAvailable: boolean;
  asOf: string;
  technicals?: AskTechnical[];
  indices?: AskIndex[];
  watchlist?: PlanWatchlistEntry[];
  themeHeat?: ThemeHeatSummary;
  dataHealth?: MarketDataHealth;
  webSearch?: AskWebSearchContext;
}

/**
 * Builds the exact de-identified context bundle fed to the brain. Exported so the
 * replay/backtest pipeline assembles the SAME shape the live brain receives (no
 * drifting replica) — it just never sends it to a model in P0.
 */
export function buildAskContext(input: BuildAskContextInput): Record<string, JsonValue> {
  const { valuation, pricesAvailable, asOf, technicals, indices, watchlist, themeHeat, dataHealth, webSearch } =
    input;
  return {
    asOf,
    pricesAvailable,
    ...(themeHeat
      ? {
          themeHeat: {
            limitUpCount: themeHeat.limitUpCount,
            limitDownCount: themeHeat.limitDownCount,
            advancers: themeHeat.advancers,
            decliners: themeHeat.decliners,
            heatScore: themeHeat.heatScore,
            topGainers: themeHeat.topGainers.slice(0, 5),
            degraded: themeHeat.degraded,
          },
        }
      : {}),
    ...(dataHealth
      ? {
          dataHealth: {
            asOf: dataHealth.asOf,
            pricedSymbols: dataHealth.pricedSymbols,
            indicesCount: dataHealth.indicesCount,
            watchlistCount: dataHealth.watchlistCount,
            degraded: dataHealth.degraded,
            notes: dataHealth.notes.slice(0, 6),
          },
        }
      : {}),
    ...(watchlist && watchlist.length > 0
      ? {
          watchlist: {
            count: watchlist.length,
            top: watchlist.slice(0, 20).map((entry) => ({
              symbol: entry.symbol,
              market: entry.market,
              name: entry.name,
              rank: entry.rank,
            })),
          },
        }
      : {}),
    ...(technicals && technicals.length > 0
      ? {
          technicals: technicals.map((t) => ({
            symbol: t.symbol,
            market: t.market,
            name: t.name ?? null,
            asOfDate: t.asOfDate,
            trend: t.trend,
            ma5: t.ma5 ?? null,
            ma10: t.ma10 ?? null,
            ma20: t.ma20 ?? null,
            high60: t.high60,
            low60: t.low60,
            rangePosition60: t.rangePosition60,
          })),
        }
      : {}),
    ...(indices && indices.length > 0
      ? {
          indices: indices.map((index) => ({
            indexId: index.indexId ?? null,
            name: index.name,
            latestPrice: index.latestPrice,
            changePct: index.changePct,
            asOfDate: index.asOfDate ?? null,
          })),
        }
      : {}),
    ...(webSearch && webSearch.results.length > 0
      ? {
          webSearch: {
            query: webSearch.query,
            answer: webSearch.answer ?? null,
            results: webSearch.results.slice(0, 8).map((result) => ({
              title: result.title,
              url: result.url,
              snippet: result.snippet.slice(0, 1200),
            })),
          },
        }
      : {}),
    account: {
      accountId: valuation.accountId,
      availableCash: valuation.cash.available,
      frozenCash: valuation.cash.frozen,
      totalCash: valuation.cash.total,
    },
    totals: {
      totalAssets: valuation.totalAssets,
      totalPositionMarketValue: valuation.totalPositionMarketValue,
      totalCostBasis: valuation.totalCostBasis,
      totalUnrealizedPnl: valuation.totalUnrealizedPnl,
      investedRatio: valuation.investedRatio,
    },
    positions: valuation.positions.map((position) => ({
      symbol: position.symbol,
      market: position.market,
      name: position.name,
      quantity: position.quantity,
      sellableQuantity: position.sellableQuantity,
      costPrice: position.costPrice,
      latestPrice: position.latestPrice,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
      unrealizedPnlRatio: position.unrealizedPnlRatio,
      positionRatio: position.positionRatio,
    })),
  };
}

function buildAskAudit(input: {
  requestId: string;
  generatedAt: string;
  account: Account;
  valuation: PortfolioValuation;
  provider: string;
  pricesAvailable: boolean;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: `audit-ask-${input.requestId}`.slice(0, 128),
    occurredAt: input.generatedAt,
    actor: { type: "cli", id: "ask-portfolio" },
    action: "read",
    subject: { type: "account", id: input.account.accountId },
    severity: "info",
    result: "success",
    message: `Answered portfolio question for ${input.account.accountId}`,
    correlationId: input.requestId,
    metadata: {
      provider: input.provider,
      pricesAvailable: input.pricesAvailable,
      positionCount: input.valuation.positions.length,
      totalAssets: input.valuation.totalAssets,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function normalizeNow(now: string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }

  const parsed = new Date(now);

  if (Number.isNaN(parsed.getTime())) {
    throw new AskPortfolioError(`Invalid timestamp: ${now}`);
  }

  return parsed.toISOString();
}

export class AskPortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskPortfolioError";
  }
}
