import { z } from "zod";
import {
  brainInputSchema,
  generateBrainOutput,
  type BrainProvider,
} from "../domain/brain/index.js";
import type { WatchlistEntry, WatchlistPriority } from "../domain/market/index.js";
import type { Position } from "../domain/portfolio/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
  type JsonValue,
} from "../domain/shared/index.js";
import type { AskWebSearchContext, MarketDataHealth } from "./ask-portfolio.js";
import type { PlanShortlistEntry } from "../domain/plan/index.js";
import type { TradeIntentReviewProposal } from "../domain/memory/index.js";

export const potentialStockPrioritySchema = z.enum(["high", "medium", "low", "holding"]);
export type PotentialStockPriority = z.infer<typeof potentialStockPrioritySchema>;

export const potentialStockCandidateSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    priority: potentialStockPrioritySchema.default("medium"),
    rationale: z.string().trim().min(1).max(1000),
    rank: z.number().int().positive().nullable().optional(),
    latestPrice: z.number().finite().positive().optional(),
    changePct: z.number().finite().optional(),
    turnoverRate: z.number().finite().optional(),
    amount: z.number().finite().nonnegative().optional(),
    mainNetInflow: z.number().finite().optional(),
    sector: z.string().trim().min(1).max(80).optional(),
    bucketLabel: z.string().trim().min(1).max(80).optional(),
    hotTheme: z.string().trim().min(1).max(80).optional(),
    dailyTrend: z.string().trim().min(1).max(80).optional(),
    limitState: z.string().trim().min(1).max(80).optional(),
    isHeld: z.boolean().default(false),
    holdingQuantity: z.number().int().nonnegative().optional(),
    costPrice: z.number().finite().nonnegative().optional(),
    unrealizedPnlRatio: z.number().finite().optional(),
  })
  .strict();

export type PotentialStockCandidate = z.infer<typeof potentialStockCandidateSchema>;

const potentialStockAdviceSchema = z
  .object({
    idealBuyPoint: z.string().trim().min(1).max(160),
    stopLoss: z.string().trim().min(1).max(160),
    target: z.string().trim().min(1).max(160),
    position: z.string().trim().min(1).max(160),
    priority: z.string().trim().min(1).max(80),
  })
  .strict();

export const potentialStockAnalysisItemSchema = z.object({
  symbol: stockSymbolSchema,
  market: stockMarketSchema,
  name: z.string().trim().min(1).max(80),
  priority: potentialStockPrioritySchema,
  currentLabel: z.string().trim().min(1).max(80).optional(),
  coreLogic: z.string().trim().min(1).max(220),
  reasons: z.array(z.string().trim().min(1).max(220)).min(1).max(5),
  buyAdvice: potentialStockAdviceSchema,
  risks: z.array(z.string().trim().min(1).max(180)).min(1).max(4),
  trackingPoints: z.array(z.string().trim().min(1).max(180)).min(1).max(4),
});

const potentialStockRecommendationsSchema = z.object({
  firstChoice: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
  secondChoice: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
  defensive: z.array(z.string().trim().min(1).max(160)).max(5).default([]),
});

const potentialStockFollowUpSchema = z.object({
  symbol: stockSymbolSchema,
  name: z.string().trim().min(1).max(80),
  point: z.string().trim().min(1).max(180),
});

const emptyRecommendations = {
  firstChoice: [] as string[],
  secondChoice: [] as string[],
  defensive: [] as string[],
};

const potentialStockAnalysisModelSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().min(1).max(1200),
  recommendations: potentialStockRecommendationsSchema.default(emptyRecommendations),
  stocks: z.array(potentialStockAnalysisItemSchema).min(1).max(10),
  followUps: z.array(potentialStockFollowUpSchema).max(10).default([]),
  safetyNotes: z.array(z.string().trim().min(1).max(180)).max(6).default([]),
});

export const potentialStockAnalysisReportSchema = z
  .object({
    reportId: identifierSchema,
    tradingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    generatedAt: isoDateTimeSchema,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(1200),
    sourceStockCount: z.number().int().positive().max(100),
    analyzedStockCount: z.number().int().positive().max(10),
    degraded: z.boolean(),
    recommendations: potentialStockRecommendationsSchema,
    stocks: z.array(potentialStockAnalysisItemSchema).min(1).max(10),
    followUps: z.array(potentialStockFollowUpSchema).max(10),
    safetyNotes: z.array(z.string().trim().min(1).max(180)).max(8),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export type PotentialStockAnalysisItem = z.infer<typeof potentialStockAnalysisItemSchema>;
export type PotentialStockAnalysisReport = z.infer<typeof potentialStockAnalysisReportSchema>;

export interface AnalyzePotentialStocksInput {
  candidates: readonly PotentialStockCandidate[];
  question?: string;
  now?: string;
  poolOverview?: string;
  proposals?: readonly TradeIntentReviewProposal[];
  positions?: readonly Position[];
  dataHealth?: MarketDataHealth;
  webSearch?: AskWebSearchContext;
  maxStocks?: number;
}

export interface AnalyzePotentialStocksResult {
  report: PotentialStockAnalysisReport;
  provider: string;
  model: string;
  confidence: number;
}

export async function analyzePotentialStocks(
  input: AnalyzePotentialStocksInput,
  dependencies: { brainProvider: BrainProvider },
): Promise<AnalyzePotentialStocksResult> {
  const generatedAt = normalizeNow(input.now);
  const maxStocks = Math.min(Math.max(input.maxStocks ?? 10, 1), 10);
  const candidates = dedupeCandidates(input.candidates).slice(0, maxStocks);

  if (candidates.length === 0) {
    throw new PotentialStockAnalysisError("potential stock candidates must not be empty");
  }

  const fallback = buildFallbackReport({
    candidates,
    generatedAt,
    degraded: true,
    metadata: {
      fallback: true,
      reason: "model_output_unavailable",
    },
  });

  try {
    const output = await generateBrainOutput(
      dependencies.brainProvider,
      buildPotentialStockAnalysisBrainInput({
        candidates,
        generatedAt,
        question: input.question,
        poolOverview: input.poolOverview,
        proposals: input.proposals,
        positions: input.positions,
        dataHealth: input.dataHealth,
        webSearch: input.webSearch,
      }),
      { structuredOutputSchema: potentialStockAnalysisModelSchema },
    );
    const parsed = potentialStockAnalysisModelSchema.safeParse(output.structured);

    if (!parsed.success) {
      return {
        report: fallback,
        provider: output.provider,
        model: output.model,
        confidence: output.confidence,
      };
    }

    return {
      report: mergeModelReport({
        model: parsed.data,
        candidates,
        generatedAt,
        provider: output.provider,
        modelName: output.model,
        confidence: output.confidence,
      }),
      provider: output.provider,
      model: output.model,
      confidence: output.confidence,
    };
  } catch {
    return {
      report: fallback,
      provider: "local",
      model: "deterministic-fallback",
      confidence: 0,
    };
  }
}

export function buildPotentialStockAnalysisBrainInput(input: {
  candidates: readonly PotentialStockCandidate[];
  generatedAt: string;
  question?: string;
  poolOverview?: string;
  proposals?: readonly TradeIntentReviewProposal[];
  positions?: readonly Position[];
  dataHealth?: MarketDataHealth;
  webSearch?: AskWebSearchContext;
}) {
  const tradingDate = input.generatedAt.slice(0, 10);
  const requestId = `potential-analysis-${input.generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const candidateLines = input.candidates.map((candidate, index) => {
    const parts = [
      `${index + 1}. ${candidate.name}(${candidate.symbol})`,
      `priority=${candidate.priority}`,
      candidate.rank ? `rank=${candidate.rank}` : undefined,
      candidate.latestPrice ? `latest=${formatMoney(candidate.latestPrice)}` : undefined,
      candidate.changePct !== undefined ? `change=${formatPct(candidate.changePct)}` : undefined,
      candidate.turnoverRate !== undefined ? `turnover=${candidate.turnoverRate.toFixed(2)}%` : undefined,
      candidate.mainNetInflow !== undefined ? `mainFlow=${formatYi(candidate.mainNetInflow)}` : undefined,
      candidate.sector ? `sector=${candidate.sector}` : undefined,
      candidate.hotTheme ? `theme=${candidate.hotTheme}` : undefined,
      candidate.dailyTrend ? `trend=${candidate.dailyTrend}` : undefined,
      `reason=${candidate.rationale}`,
    ].filter((part): part is string => part !== undefined);
    return parts.join(" | ");
  });

  return brainInputSchema.parse({
    requestId,
    taskType: "user_query",
    prompt: [
      `当前交易日：${tradingDate}，时区 Asia/Shanghai。`,
      "你要生成【潜力股池深度分析】。这只是模拟盘/人工复核用研究报告，不是订单。",
      "严格只分析候选清单里的股票，严禁引入池外代码；缺失的数据直接写“数据缺失”，不要编造价格、涨幅、资金、新闻或业绩。",
      "每支股票必须包含：核心逻辑、为什么选它（主线/催化/技术/资金/业绩里能确定的部分）、买点/止损/目标/仓位建议、2-3条风险、后续跟踪点。",
      "仓位只能写成待风控复核的建议，单票建议不超过 15%；已持仓标的要说明以当前持仓和风控为准，不允许写满仓/梭哈。",
      "输出 JSON 放在 structured 字段，格式：",
      '{"summary":"总览","recommendations":{"firstChoice":["名称 价格/条件 理由"],"secondChoice":[],"defensive":[]},"stocks":[{"symbol":"000001","market":"SZSE","name":"平安银行","priority":"high|medium|low|holding","currentLabel":"+3.2%","coreLogic":"一句话核心逻辑","reasons":["理由1","理由2"],"buyAdvice":{"idealBuyPoint":"...","stopLoss":"...","target":"...","position":"...","priority":"..."},"risks":["风险1","风险2"],"trackingPoints":["观察点1","观察点2"]}],"followUps":[{"symbol":"000001","name":"平安银行","point":"明日观察点"}],"safetyNotes":["只读分析，未下单"]}',
      "",
      `用户原问题：${input.question?.trim() || "生成今日潜力股池深度分析"}`,
      "",
      "候选清单（后端确定性来源）：",
      ...candidateLines,
      input.poolOverview?.trim() ? `\n观察池概览（确定性数据）：\n${clip(input.poolOverview.trim(), 5000)}` : "",
      input.proposals && input.proposals.length > 0
        ? `\n后端待复核买卖候选：${input.proposals
            .slice(0, 8)
            .map((proposal) => `${proposal.side} ${proposal.name ?? proposal.symbol}(${proposal.symbol}) ${proposal.rationale}`)
            .join("；")}`
        : "",
      input.dataHealth?.degraded ? `\n数据降级提示：${input.dataHealth.notes.join("；")}` : "",
      input.webSearch && input.webSearch.results.length > 0
        ? `\n联网检索摘要：${input.webSearch.results
            .slice(0, 5)
            .map((item) => `${item.title}: ${clip(item.snippet, 300)}`)
            .join("\n")}`
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n"),
    context: {
      source: "potential_stocks",
      tradingDate,
      candidateCount: input.candidates.length,
      candidates: input.candidates.map(candidateContext),
      heldSymbols: (input.positions ?? []).map((position) => position.symbol),
      proposalCount: input.proposals?.length ?? 0,
      dataHealth: input.dataHealth
        ? {
            degraded: input.dataHealth.degraded,
            notes: input.dataHealth.notes.slice(0, 6),
          }
        : null,
    },
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      schemaName: "potential_stock_analysis_report",
      maxSummaryLength: 12_000,
      toolPermissions: [],
    },
    createdAt: input.generatedAt,
  });
}

export function renderPotentialStockAnalysisReport(report: PotentialStockAnalysisReport): string {
  const groups = groupStocks(report.stocks);
  const lines: string[] = [
    `📊 ${formatDateZh(report.tradingDate)}潜力股池（${report.stocks.length} 支深度分析）${report.degraded ? "（模型降级）" : ""}`,
    "每支包含：核心逻辑 / 入选理由 / 买点止损目标仓位 / 风险 / 跟踪点",
    "",
    report.summary,
    "",
    "10 支潜力股速览",
  ];

  report.stocks.forEach((stock, index) => {
    lines.push(
      `${index + 1}. ${stock.name}(${stock.symbol})｜${priorityLabel(stock.priority)}｜${clip(stock.coreLogic, 34)}｜买点：${stock.buyAdvice.idealBuyPoint}`,
    );
  });

  if (
    report.recommendations.firstChoice.length > 0 ||
    report.recommendations.secondChoice.length > 0 ||
    report.recommendations.defensive.length > 0
  ) {
    lines.push("", "重点推荐（现金充足且通过风控时）");
    pushRecommendation(lines, "🔴 首选", report.recommendations.firstChoice);
    pushRecommendation(lines, "🟡 次选", report.recommendations.secondChoice);
    pushRecommendation(lines, "🟢 防御/观察", report.recommendations.defensive);
  }

  pushGroup(lines, "🔴 优先级：高", groups.high);
  pushGroup(lines, "🟢 已持仓/持仓优先跟踪", groups.holding);
  pushGroup(lines, "🟡 优先级：中", groups.medium);
  pushGroup(lines, "🟢 优先级：低", groups.low);

  const followUps =
    report.followUps.length > 0
      ? report.followUps
      : report.stocks.slice(0, 6).map((stock) => ({
          symbol: stock.symbol,
          name: stock.name,
          point: stock.trackingPoints[0] ?? "观察入选逻辑是否延续",
        }));
  if (followUps.length > 0) {
    lines.push("", "⚠️ 后续跟踪要点");
    followUps.forEach((item) => lines.push(`${item.name}(${item.symbol})：${item.point}`));
  }

  lines.push("", ...report.safetyNotes.map((note) => `安全边界：${note}`));
  return lines.join("\n");
}

export function watchlistEntryToPotentialStockCandidate(
  entry: WatchlistEntry,
  options?: {
    position?: Position;
    latestPrice?: number;
  },
): PotentialStockCandidate {
  const metadata = entry.metadata ?? {};
  const position = options?.position;
  const latestPrice =
    options?.latestPrice ?? readNumber(metadata, "latestPrice") ?? position?.latestPrice ?? undefined;

  return potentialStockCandidateSchema.parse({
    symbol: entry.symbol,
    market: entry.market,
    name: entry.name,
    priority: position ? "holding" : priorityFromWatchlist(entry.priority),
    rationale: entry.reason,
    rank: readNumber(metadata, "rank") ?? undefined,
    latestPrice: latestPrice && latestPrice > 0 ? latestPrice : undefined,
    changePct: readNumber(metadata, "changePct") ?? undefined,
    turnoverRate: readNumber(metadata, "turnoverRate") ?? undefined,
    amount: readNumber(metadata, "amount") ?? undefined,
    mainNetInflow: readNumber(metadata, "mainNetInflow") ?? undefined,
    sector: readString(metadata, "sector"),
    bucketLabel: readString(metadata, "bucketLabel"),
    hotTheme: readString(metadata, "hotTheme"),
    dailyTrend: readString(metadata, "dailyTrend"),
    limitState: readString(metadata, "limitState"),
    isHeld: Boolean(position),
    holdingQuantity: position?.quantity,
    costPrice: position?.costPrice,
  });
}

export function candidatesFromShortlist(input: {
  shortlist: readonly PlanShortlistEntry[];
  details?: readonly PotentialStockCandidate[];
  positions?: readonly Position[];
  prices?: Record<string, number>;
}): PotentialStockCandidate[] {
  const detailBySymbol = new Map((input.details ?? []).map((candidate) => [candidate.symbol, candidate]));
  const positionBySymbol = new Map((input.positions ?? []).map((position) => [position.symbol, position]));

  return input.shortlist.map((entry, index) => {
    const detail = detailBySymbol.get(entry.symbol);
    const position = positionBySymbol.get(entry.symbol);
    const latestPrice = input.prices?.[entry.symbol] ?? detail?.latestPrice ?? position?.latestPrice;
    return potentialStockCandidateSchema.parse({
      ...(detail ?? {}),
      symbol: entry.symbol,
      market: entry.market,
      name: entry.name,
      priority: position ? "holding" : (detail?.priority ?? "high"),
      rationale: entry.rationale || detail?.rationale || "入选潜力股池",
      rank: entry.rank ?? detail?.rank ?? index + 1,
      latestPrice: latestPrice && latestPrice > 0 ? latestPrice : undefined,
      isHeld: Boolean(position),
      holdingQuantity: position?.quantity ?? detail?.holdingQuantity,
      costPrice: position?.costPrice ?? detail?.costPrice,
    });
  });
}

function mergeModelReport(input: {
  model: z.infer<typeof potentialStockAnalysisModelSchema>;
  candidates: readonly PotentialStockCandidate[];
  generatedAt: string;
  provider: string;
  modelName: string;
  confidence: number;
}): PotentialStockAnalysisReport {
  const fallback = buildFallbackReport({
    candidates: input.candidates,
    generatedAt: input.generatedAt,
    degraded: false,
    metadata: {},
  });
  const candidateBySymbol = new Map(input.candidates.map((candidate) => [candidate.symbol, candidate]));
  const fallbackBySymbol = new Map(fallback.stocks.map((stock) => [stock.symbol, stock]));
  const seen = new Set<string>();
  const stocks: PotentialStockAnalysisItem[] = [];

  for (const item of input.model.stocks) {
    const candidate = candidateBySymbol.get(item.symbol);
    if (!candidate || seen.has(item.symbol)) {
      continue;
    }
    seen.add(item.symbol);
    stocks.push(
      potentialStockAnalysisItemSchema.parse({
        ...item,
        market: candidate.market,
        name: candidate.name,
        priority: candidate.priority,
      }),
    );
  }

  for (const candidate of input.candidates) {
    if (!seen.has(candidate.symbol)) {
      const fallbackItem = fallbackBySymbol.get(candidate.symbol);
      if (fallbackItem) {
        stocks.push(fallbackItem);
      }
    }
  }

  return potentialStockAnalysisReportSchema.parse({
    reportId: makeReportId(input.generatedAt),
    tradingDate: input.generatedAt.slice(0, 10),
    generatedAt: input.generatedAt,
    title: input.model.title ?? "潜力股池深度分析",
    summary: input.model.summary,
    sourceStockCount: input.candidates.length,
    analyzedStockCount: stocks.length,
    degraded: false,
    recommendations: input.model.recommendations,
    stocks,
    followUps: input.model.followUps.filter((item) => candidateBySymbol.has(item.symbol)),
    safetyNotes:
      input.model.safetyNotes.length > 0
        ? input.model.safetyNotes
        : defaultSafetyNotes(),
    metadata: {
      provider: input.provider,
      model: input.modelName,
      confidence: input.confidence,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function buildFallbackReport(input: {
  candidates: readonly PotentialStockCandidate[];
  generatedAt: string;
  degraded: boolean;
  metadata: Record<string, JsonValue>;
}): PotentialStockAnalysisReport {
  const stocks = input.candidates.map(fallbackStockAnalysis);
  return potentialStockAnalysisReportSchema.parse({
    reportId: makeReportId(input.generatedAt),
    tradingDate: input.generatedAt.slice(0, 10),
    generatedAt: input.generatedAt,
    title: "潜力股池深度分析",
    summary: `本次基于后端确定性潜力池生成 ${stocks.length} 支股票分析；模型不可用或结构化输出不可用时，已按池内理由、价格、资金和趋势元数据降级生成。`,
    sourceStockCount: input.candidates.length,
    analyzedStockCount: stocks.length,
    degraded: input.degraded,
    recommendations: fallbackRecommendations(stocks),
    stocks,
    followUps: stocks.slice(0, 6).map((stock) => ({
      symbol: stock.symbol,
      name: stock.name,
      point: stock.trackingPoints[0] ?? "观察入选逻辑是否延续",
    })),
    safetyNotes: defaultSafetyNotes(),
    metadata: {
      ...input.metadata,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function fallbackStockAnalysis(candidate: PotentialStockCandidate): PotentialStockAnalysisItem {
  const price = candidate.latestPrice;
  const reasons = compact([
    candidate.rationale,
    candidate.bucketLabel ? `${candidate.bucketLabel}信号` : undefined,
    candidate.hotTheme ? `热门题材：${candidate.hotTheme}` : undefined,
    candidate.sector ? `所属板块：${candidate.sector}` : undefined,
    candidate.mainNetInflow !== undefined ? `主力净流入 ${formatYi(candidate.mainNetInflow)}` : undefined,
    candidate.dailyTrend ? `日线趋势：${trendLabel(candidate.dailyTrend)}` : undefined,
  ]).slice(0, 5);

  return potentialStockAnalysisItemSchema.parse({
    symbol: candidate.symbol,
    market: candidate.market,
    name: candidate.name,
    priority: candidate.priority,
    currentLabel: candidate.changePct !== undefined ? formatPct(candidate.changePct) : undefined,
    coreLogic: clip(candidate.rationale, 120),
    reasons: reasons.length > 0 ? reasons : ["入选后端潜力股池，等待更多行情数据确认。"],
    buyAdvice: {
      idealBuyPoint: price ? `${formatMoney(price * 0.95)}-${formatMoney(price * 0.98)} 元（回调确认）` : "数据缺失：等待实时价和支撑位确认",
      stopLoss: price ? `${formatMoney(price * 0.9)} 元附近（约 -10%，仍需风控复核）` : "跌破入选逻辑或关键支撑即撤销",
      target: price ? `${formatMoney(price * 1.15)}-${formatMoney(price * 1.2)} 元（分批止盈）` : "先看入选逻辑延续，再设阶段目标",
      position: candidate.isHeld
        ? `已持仓 ${candidate.holdingQuantity ?? 0} 股；新增需按现有仓位和风控复核`
        : "单票建议不超过 10%-15%，必须再过现金/仓位/100股规则",
      priority: priorityText(candidate.priority),
    },
    risks: fallbackRisks(candidate),
    trackingPoints: fallbackTracking(candidate),
  });
}

function fallbackRisks(candidate: PotentialStockCandidate): string[] {
  const risks = compact([
    candidate.changePct !== undefined && pctPoints(candidate.changePct) >= 8 ? "短线涨幅偏大，追高回撤风险。" : undefined,
    candidate.mainNetInflow !== undefined && candidate.mainNetInflow < 0 ? "主力净流出，资金延续性存疑。" : undefined,
    candidate.turnoverRate !== undefined && candidate.turnoverRate >= 15 ? "高换手意味着分歧较大，波动会放大。" : undefined,
    candidate.limitState === "limit_down" ? "跌停/弱势标签尚未解除，不适合无确认抄底。" : undefined,
  ]);
  risks.push("题材退潮或大盘转弱时，入选逻辑可能快速失效。");
  return risks.slice(0, 3);
}

function fallbackTracking(candidate: PotentialStockCandidate): string[] {
  return compact([
    candidate.latestPrice ? `观察能否站稳 ${formatMoney(candidate.latestPrice)} 元附近并保持量能。` : "先补实时行情，确认价格和量能。",
    candidate.mainNetInflow !== undefined ? "跟踪主力净流入是否延续，若转负要降级观察。" : "跟踪资金面是否出现持续净流入。",
    candidate.hotTheme ? `观察 ${candidate.hotTheme} 题材是否继续扩散。` : "观察所属板块是否继续领涨。",
  ]).slice(0, 3);
}

function fallbackRecommendations(stocks: PotentialStockAnalysisItem[]) {
  const buyLine = (stock: PotentialStockAnalysisItem) =>
    `${stock.name}(${stock.symbol}) ${stock.buyAdvice.idealBuyPoint}｜${clip(stock.coreLogic, 40)}`;
  return potentialStockRecommendationsSchema.parse({
    firstChoice: stocks.filter((stock) => stock.priority === "high").slice(0, 2).map(buyLine),
    secondChoice: stocks.filter((stock) => stock.priority === "medium").slice(0, 3).map(buyLine),
    defensive: stocks
      .filter((stock) => stock.priority === "low" || stock.priority === "holding")
      .slice(0, 3)
      .map(buyLine),
  });
}

function defaultSafetyNotes(): string[] {
  return [
    "本报告只读生成，未下单、未写账户、未绕过风控。",
    "买卖必须另走 PolicyEngine / RiskEngine / PaperBroker 或人工复核路径。",
  ];
}

function groupStocks(stocks: readonly PotentialStockAnalysisItem[]) {
  return {
    high: stocks.filter((stock) => stock.priority === "high"),
    holding: stocks.filter((stock) => stock.priority === "holding"),
    medium: stocks.filter((stock) => stock.priority === "medium"),
    low: stocks.filter((stock) => stock.priority === "low"),
  };
}

function pushGroup(lines: string[], title: string, stocks: readonly PotentialStockAnalysisItem[]): void {
  if (stocks.length === 0) {
    return;
  }
  lines.push("", `${title}（${stocks.length} 支）`);
  stocks.forEach((stock, index) => {
    lines.push(
      `${index + 1}. ${stock.name} (${stock.symbol})${stock.currentLabel ? ` ${stock.currentLabel}` : ""}`,
      `核心逻辑：${stock.coreLogic}`,
      `- 为什么选：${stock.reasons.join("；")}`,
      `- 买点：${stock.buyAdvice.idealBuyPoint}`,
      `- 止损：${stock.buyAdvice.stopLoss}`,
      `- 目标：${stock.buyAdvice.target}`,
      `- 仓位：${stock.buyAdvice.position}`,
      `- 风险：${stock.risks.join("；")}`,
      `- 跟踪：${stock.trackingPoints.join("；")}`,
    );
  });
}

function pushRecommendation(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(title);
  items.forEach((item) => lines.push(`- ${item}`));
}

function dedupeCandidates(candidates: readonly PotentialStockCandidate[]): PotentialStockCandidate[] {
  const bySymbol = new Map<string, PotentialStockCandidate>();
  for (const candidate of candidates) {
    const parsed = potentialStockCandidateSchema.parse(candidate);
    if (!bySymbol.has(parsed.symbol)) {
      bySymbol.set(parsed.symbol, parsed);
    }
  }
  return [...bySymbol.values()].sort((left, right) => (left.rank ?? 9999) - (right.rank ?? 9999));
}

function candidateContext(candidate: PotentialStockCandidate): Record<string, JsonValue> {
  return {
    symbol: candidate.symbol,
    market: candidate.market,
    name: candidate.name,
    priority: candidate.priority,
    rationale: candidate.rationale,
    rank: candidate.rank ?? null,
    latestPrice: candidate.latestPrice ?? null,
    changePct: candidate.changePct ?? null,
    turnoverRate: candidate.turnoverRate ?? null,
    amount: candidate.amount ?? null,
    mainNetInflow: candidate.mainNetInflow ?? null,
    sector: candidate.sector ?? null,
    bucketLabel: candidate.bucketLabel ?? null,
    hotTheme: candidate.hotTheme ?? null,
    dailyTrend: candidate.dailyTrend ?? null,
    limitState: candidate.limitState ?? null,
    isHeld: candidate.isHeld,
  };
}

function priorityFromWatchlist(priority: WatchlistPriority): PotentialStockPriority {
  return priority;
}

function priorityLabel(priority: PotentialStockPriority): string {
  switch (priority) {
    case "high":
      return "高";
    case "medium":
      return "中";
    case "low":
      return "低";
    case "holding":
      return "持仓";
  }
}

function priorityText(priority: PotentialStockPriority): string {
  return priority === "holding" ? "持仓优先跟踪" : `优先级${priorityLabel(priority)}`;
}

function trendLabel(value: string): string {
  if (value === "uptrend") {
    return "上升趋势";
  }
  if (value === "downtrend") {
    return "下降趋势";
  }
  if (value === "sideways") {
    return "横盘";
  }
  return value;
}

function readNumber(metadata: Record<string, JsonValue>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(metadata: Record<string, JsonValue>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pctPoints(value: number): number {
  return Math.abs(value) <= 1 ? value * 100 : value;
}

function formatPct(value: number): string {
  const points = pctPoints(value);
  return `${points >= 0 ? "+" : ""}${points.toFixed(2)}%`;
}

function formatMoney(value: number): string {
  return trimZeros(value.toFixed(value >= 100 ? 1 : 2));
}

function formatYi(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${(Math.abs(value) / 1e8).toFixed(2)}亿`;
}

function trimZeros(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function formatDateZh(date: string): string {
  const [, month, day] = date.split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function makeReportId(generatedAt: string): string {
  return `potential-analysis-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
}

function normalizeNow(now: string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }
  const parsed = new Date(now);
  if (Number.isNaN(parsed.getTime())) {
    throw new PotentialStockAnalysisError(`Invalid timestamp: ${now}`);
  }
  return parsed.toISOString();
}

function compact(values: Array<string | undefined | false>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export class PotentialStockAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PotentialStockAnalysisError";
  }
}
