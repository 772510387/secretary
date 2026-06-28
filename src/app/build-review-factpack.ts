import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  accountSchema,
  calculatePortfolioValuation,
  positionSchema,
  roundMoney,
  roundPrice,
  roundRatio,
  tradeRecordSchema,
  type Account,
  type Position,
  type PositionValuation,
  type PortfolioValuation,
  type TradeRecord,
} from "../domain/portfolio/index.js";

const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

const dailySnapshotSummarySchema = z
  .object({
    tradingDate: z.string().regex(TRADING_DATE_PATTERN),
    totalAssets: z.number().finite(),
    availableCash: z.number().finite(),
    investedRatio: z.number().finite(),
    positionCount: z.number().int().nonnegative(),
    totalUnrealizedPnl: z.number().finite(),
    generatedAt: z.string().datetime(),
  })
  .strict();

const snapshotDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("daily-portfolio-snapshot"),
    tradingDate: z.string().regex(TRADING_DATE_PATTERN),
    generatedAt: z.string().datetime(),
    pricesAvailable: z.boolean(),
    account: accountSchema,
    valuation: z
      .object({
        accountId: z.string(),
        cash: z.object({ available: z.number(), frozen: z.number(), total: z.number() }),
        positions: z.array(z.any()),
        totalPositionMarketValue: z.number().finite(),
        totalCostBasis: z.number().finite(),
        totalUnrealizedPnl: z.number().finite(),
        totalAssets: z.number().finite(),
        investedRatio: z.number().finite(),
      })
      .passthrough(),
    summary: dailySnapshotSummarySchema,
  })
  .passthrough();

export interface ReviewPositionLot {
  symbol: string;
  market: "SSE" | "SZSE";
  name: string;
  quantity: number;
  costPrice: number;
}

export interface ReviewDecisionNode {
  beijingTime: string;
  symbol?: string;
  name?: string;
  price?: number;
  changePct?: number;
  decision: string;
  action: string;
  logic: string;
  source: "trade" | "alarm" | "replay" | "manual";
}

export interface ReviewTradeTimelineItem extends ReviewDecisionNode {
  tradeId: string;
  intentId?: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  grossAmount: number;
  netAmount: number;
  realizedPnl?: number;
  realizedPnlKnownQuantity: number;
  realizedPnlUnknownQuantity: number;
}

export interface ReviewOperationStats {
  buyCount: number;
  sellCount: number;
  holdCount: number;
  buyQuantity: number;
  sellQuantity: number;
  buyAmount: number;
  sellAmount: number;
}

export interface ReviewAssetSummary {
  startAssets: number;
  endAssets: number;
  pnlAmount: number;
  pnlRatio: number;
  startSource: "previous_snapshot" | "account_initial_cash" | "provided";
  endSource: "daily_snapshot" | "current_valuation" | "provided";
  realizedPnl: number | null;
  realizedPnlKnownQuantity: number;
  realizedPnlUnknownQuantity: number;
  unrealizedPnl: number;
}

export interface TradingDayReviewFactPack {
  tradingDate: string;
  generatedAt: string;
  accountId: string;
  asset: ReviewAssetSummary;
  operationStats: ReviewOperationStats;
  tradeTimeline: ReviewTradeTimelineItem[];
  decisionTimeline: ReviewDecisionNode[];
  finalPositions: PositionValuation[];
  dataQuality: string[];
}

export interface BuildTradingDayReviewFactPackInput {
  tradingDate: string;
  account: Account;
  positions: Position[];
  trades: readonly TradeRecord[];
  generatedAt?: string;
  previousSummary?: DailySnapshotSummaryLike;
  currentSummary?: DailySnapshotSummaryLike;
  openingPositions?: readonly ReviewPositionLot[];
  proposalRationales?: Record<string, string>;
  decisionNodes?: readonly ReviewDecisionNode[];
  prices?: Record<string, number>;
  t1Enabled?: boolean;
}

export interface DailySnapshotSummaryLike {
  tradingDate: string;
  totalAssets: number;
  totalUnrealizedPnl?: number;
}

export interface BuildTradingDayReviewFromMemoryInput {
  memoryDir: string;
  tradingDate: string;
  generatedAt?: string;
  t1Enabled?: boolean;
}

export function buildTradingDayReviewFactPack(
  input: BuildTradingDayReviewFactPackInput,
): TradingDayReviewFactPack {
  assertTradingDate(input.tradingDate);
  const generatedAt = normalizeIso(input.generatedAt ?? new Date().toISOString(), "generatedAt");
  const account = accountSchema.parse(input.account);
  const positions = input.positions.map((position) => positionSchema.parse(position));
  const trades = input.trades
    .map((trade) => tradeRecordSchema.parse(trade))
    .filter((trade) => trade.tradeDate === input.tradingDate)
    .sort((left, right) => Date.parse(left.tradedAt) - Date.parse(right.tradedAt));
  const valuation = calculatePortfolioValuation(account, positions, {
    prices: input.prices,
    t1Enabled: input.t1Enabled,
  });
  const tradePnl = buildTradeTimeline({
    trades,
    openingPositions: input.openingPositions ?? [],
    proposalRationales: input.proposalRationales ?? {},
  });
  const currentTotalAssets = input.currentSummary?.totalAssets ?? valuation.totalAssets;
  const previousAssets = input.previousSummary?.totalAssets ?? account.initialCash;
  const startSource = input.previousSummary
    ? "previous_snapshot"
    : "account_initial_cash";
  const endSource = input.currentSummary ? "daily_snapshot" : "current_valuation";
  const decisionTimeline = mergeDecisionTimeline(
    tradePnl.timeline,
    input.decisionNodes ?? [],
  );
  const stats = buildOperationStats(trades, decisionTimeline);
  const dataQuality = buildDataQuality({
    previousSummary: input.previousSummary,
    currentSummary: input.currentSummary,
    openingPositions: input.openingPositions ?? [],
    trades,
    realizedUnknownQuantity: tradePnl.realizedUnknownQuantity,
    decisionTimeline,
  });

  return {
    tradingDate: input.tradingDate,
    generatedAt,
    accountId: account.accountId,
    asset: {
      startAssets: roundMoney(previousAssets),
      endAssets: roundMoney(currentTotalAssets),
      pnlAmount: roundMoney(currentTotalAssets - previousAssets),
      pnlRatio: previousAssets > 0 ? roundRatio((currentTotalAssets - previousAssets) / previousAssets) : 0,
      startSource,
      endSource,
      realizedPnl:
        tradePnl.realizedKnownQuantity > 0 && tradePnl.realizedUnknownQuantity === 0
          ? roundMoney(tradePnl.realizedPnl)
          : tradePnl.realizedKnownQuantity > 0
            ? roundMoney(tradePnl.realizedPnl)
            : null,
      realizedPnlKnownQuantity: tradePnl.realizedKnownQuantity,
      realizedPnlUnknownQuantity: tradePnl.realizedUnknownQuantity,
      unrealizedPnl: roundMoney(input.currentSummary?.totalUnrealizedPnl ?? valuation.totalUnrealizedPnl),
    },
    operationStats: stats,
    tradeTimeline: tradePnl.timeline,
    decisionTimeline,
    finalPositions: valuation.positions,
    dataQuality,
  };
}

export function buildTradingDayReviewFactPackFromMemory(
  input: BuildTradingDayReviewFromMemoryInput,
): TradingDayReviewFactPack {
  assertTradingDate(input.tradingDate);
  const memoryDir = path.resolve(input.memoryDir);
  const currentSnapshot = readSnapshotDocument(memoryDir, input.tradingDate);
  const previousSummary = readPreviousDailySummary(memoryDir, input.tradingDate);
  const currentSummary =
    currentSnapshot?.summary ?? readDailySummaries(memoryDir).find((item) => item.tradingDate === input.tradingDate);
  const previousSnapshot = previousSummary
    ? readSnapshotDocument(memoryDir, previousSummary.tradingDate)
    : undefined;
  const account =
    currentSnapshot?.account ?? readJsonFile(path.join(memoryDir, "portfolio", "account.json"), accountSchema);
  const positions = currentSnapshot
    ? positionsFromSnapshotValuation(account, currentSnapshot.valuation.positions)
    : readJsonFile(path.join(memoryDir, "portfolio", "positions.json"), z.array(positionSchema));
  const trades = readTrades(memoryDir);
  const proposalRationales = readProposalRationales(memoryDir, input.tradingDate);

  return buildTradingDayReviewFactPack({
    tradingDate: input.tradingDate,
    account,
    positions,
    trades,
    generatedAt: input.generatedAt,
    previousSummary,
    currentSummary,
    openingPositions: previousSnapshot
      ? lotsFromValuationPositions(previousSnapshot.valuation.positions)
      : [],
    proposalRationales,
    t1Enabled: input.t1Enabled,
  });
}

function buildTradeTimeline(input: {
  trades: TradeRecord[];
  openingPositions: readonly ReviewPositionLot[];
  proposalRationales: Record<string, string>;
}): {
  timeline: ReviewTradeTimelineItem[];
  realizedPnl: number;
  realizedKnownQuantity: number;
  realizedUnknownQuantity: number;
} {
  const lots = new Map<string, Array<{ quantity: number; costPrice: number }>>();
  for (const position of input.openingPositions) {
    if (position.quantity <= 0) {
      continue;
    }
    const key = tradeKey(position.symbol, position.market);
    const existing = lots.get(key) ?? [];
    existing.push({ quantity: position.quantity, costPrice: position.costPrice });
    lots.set(key, existing);
  }

  let realizedPnl = 0;
  let realizedKnownQuantity = 0;
  let realizedUnknownQuantity = 0;
  const timeline: ReviewTradeTimelineItem[] = [];

  for (const trade of input.trades) {
    const key = tradeKey(trade.symbol, trade.market);
    if (trade.side === "BUY") {
      const existing = lots.get(key) ?? [];
      existing.push({
        quantity: trade.quantity,
        costPrice: roundPrice(trade.netAmount / trade.quantity),
      });
      lots.set(key, existing);
      timeline.push(tradeTimelineItem(trade, {
        realizedPnlKnownQuantity: 0,
        realizedPnlUnknownQuantity: 0,
        logic: rationaleForTrade(trade, input.proposalRationales),
      }));
      continue;
    }

    const matched = matchSellCost(lots.get(key) ?? [], trade.quantity, trade.netAmount);
    lots.set(key, matched.remainingLots);
    realizedPnl = roundMoney(realizedPnl + matched.realizedPnl);
    realizedKnownQuantity += matched.knownQuantity;
    realizedUnknownQuantity += matched.unknownQuantity;
    timeline.push(
      tradeTimelineItem(trade, {
        realizedPnl: matched.knownQuantity > 0 ? roundMoney(matched.realizedPnl) : undefined,
        realizedPnlKnownQuantity: matched.knownQuantity,
        realizedPnlUnknownQuantity: matched.unknownQuantity,
        logic: rationaleForTrade(trade, input.proposalRationales),
      }),
    );
  }

  return { timeline, realizedPnl, realizedKnownQuantity, realizedUnknownQuantity };
}

function tradeTimelineItem(
  trade: TradeRecord,
  options: {
    logic: string;
    realizedPnl?: number;
    realizedPnlKnownQuantity: number;
    realizedPnlUnknownQuantity: number;
  },
): ReviewTradeTimelineItem {
  const sideLabel = trade.side === "BUY" ? "买入" : "卖出";
  const decision = trade.side === "BUY" ? "建仓/加仓" : "减仓/止盈止损";
  const action = `${sideLabel} ${trade.quantity} 股 @ ${formatMoney(trade.price)}`;

  return {
    tradeId: trade.tradeId,
    intentId: trade.intentId,
    side: trade.side,
    quantity: trade.quantity,
    grossAmount: trade.grossAmount,
    netAmount: trade.netAmount,
    realizedPnl: options.realizedPnl,
    realizedPnlKnownQuantity: options.realizedPnlKnownQuantity,
    realizedPnlUnknownQuantity: options.realizedPnlUnknownQuantity,
    beijingTime: beijingClockLabel(trade.tradedAt),
    symbol: trade.symbol,
    name: trade.symbol,
    price: trade.price,
    decision,
    action,
    logic: options.logic,
    source: "trade",
  };
}

function matchSellCost(
  originalLots: Array<{ quantity: number; costPrice: number }>,
  sellQuantity: number,
  sellNetAmount: number,
): {
  realizedPnl: number;
  knownQuantity: number;
  unknownQuantity: number;
  remainingLots: Array<{ quantity: number; costPrice: number }>;
} {
  const lots = originalLots.map((lot) => ({ ...lot }));
  let remaining = sellQuantity;
  let knownQuantity = 0;
  let realizedCost = 0;

  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0]!;
    const matched = Math.min(remaining, lot.quantity);
    knownQuantity += matched;
    realizedCost += matched * lot.costPrice;
    lot.quantity -= matched;
    remaining -= matched;
    if (lot.quantity <= 0) {
      lots.shift();
    }
  }

  const knownSellProceeds = sellQuantity > 0 ? sellNetAmount * (knownQuantity / sellQuantity) : 0;

  return {
    realizedPnl: roundMoney(knownQuantity === 0 ? 0 : knownSellProceeds - realizedCost),
    knownQuantity,
    unknownQuantity: remaining,
    remainingLots: lots,
  };
}

function mergeDecisionTimeline(
  tradeTimeline: ReviewTradeTimelineItem[],
  decisionNodes: readonly ReviewDecisionNode[],
): ReviewDecisionNode[] {
  const merged: ReviewDecisionNode[] = [...decisionNodes, ...tradeTimeline].map((node) => ({
    ...node,
    price: node.price === undefined ? undefined : roundPrice(node.price),
    changePct: node.changePct === undefined ? undefined : roundRatio(node.changePct),
  }));
  return merged.sort((left, right) => clockMinutes(left.beijingTime) - clockMinutes(right.beijingTime));
}

function buildOperationStats(
  trades: readonly TradeRecord[],
  decisionTimeline: readonly ReviewDecisionNode[],
): ReviewOperationStats {
  const buys = trades.filter((trade) => trade.side === "BUY");
  const sells = trades.filter((trade) => trade.side === "SELL");
  return {
    buyCount: buys.length,
    sellCount: sells.length,
    holdCount: decisionTimeline.filter((node) => /观望|持仓|无操作|等待/.test(node.decision + node.action)).length,
    buyQuantity: buys.reduce((sum, trade) => sum + trade.quantity, 0),
    sellQuantity: sells.reduce((sum, trade) => sum + trade.quantity, 0),
    buyAmount: roundMoney(buys.reduce((sum, trade) => sum + trade.netAmount, 0)),
    sellAmount: roundMoney(sells.reduce((sum, trade) => sum + trade.netAmount, 0)),
  };
}

function buildDataQuality(input: {
  previousSummary?: DailySnapshotSummaryLike;
  currentSummary?: DailySnapshotSummaryLike;
  openingPositions: readonly ReviewPositionLot[];
  trades: readonly TradeRecord[];
  realizedUnknownQuantity: number;
  decisionTimeline: readonly ReviewDecisionNode[];
}): string[] {
  const notes: string[] = [];
  if (!input.previousSummary) {
    notes.push("缺少前一交易日收盘快照，日盈亏起点退回到账户初始资金。");
  }
  if (!input.currentSummary) {
    notes.push("缺少当日收盘快照，最终资产使用当前账户和持仓估值。");
  }
  if (input.trades.length > 0 && input.openingPositions.length === 0) {
    notes.push("缺少前一日持仓成本快照，卖出已实现盈亏只能覆盖当日买入后再卖出的部分。");
  }
  if (input.realizedUnknownQuantity > 0) {
    notes.push(`有 ${input.realizedUnknownQuantity} 股卖出缺少可回溯成本，未把该部分写成确定已实现盈亏。`);
  }
  if (!input.decisionTimeline.some((node) => typeof node.price === "number")) {
    notes.push("缺少分时价格序列，走势对照不绘制虚构分钟曲线。");
  }
  if (input.trades.some((trade) => !trade.intentId && !trade.note)) {
    notes.push("部分成交没有 intentId 或备注，复盘理由显示为未记录。");
  }
  return notes;
}

function rationaleForTrade(trade: TradeRecord, rationales: Record<string, string>): string {
  const byIntent = trade.intentId ? rationales[trade.intentId] : undefined;
  const proposalId = trade.intentId?.startsWith("intent-") ? trade.intentId.slice("intent-".length) : undefined;
  const byProposal = proposalId ? rationales[proposalId] : undefined;
  return (trade.note ?? byIntent ?? byProposal ?? "未记录").trim();
}

function readSnapshotDocument(memoryDir: string, tradingDate: string) {
  const filePath = path.join(memoryDir, "portfolio", "snapshots", `${tradingDate}.json`);
  if (!existsSync(filePath)) {
    return undefined;
  }
  return snapshotDocumentSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

function readTrades(memoryDir: string): TradeRecord[] {
  const filePath = path.join(memoryDir, "portfolio", "trades.jsonl");
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => tradeRecordSchema.parse(JSON.parse(line)));
}

function readDailySummaries(memoryDir: string): z.infer<typeof dailySnapshotSummarySchema>[] {
  const filePath = path.join(memoryDir, "portfolio", "daily-summary.jsonl");
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => dailySnapshotSummarySchema.parse(JSON.parse(line)))
    .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate));
}

function readPreviousDailySummary(memoryDir: string, tradingDate: string): DailySnapshotSummaryLike | undefined {
  return readDailySummaries(memoryDir)
    .filter((summary) => summary.tradingDate < tradingDate)
    .at(-1);
}

function readProposalRationales(memoryDir: string, tradingDate: string): Record<string, string> {
  const dateDir = path.join(memoryDir, "proposals", tradingDate);
  if (!existsSync(dateDir)) {
    return {};
  }
  const rationales: Record<string, string> = {};
  for (const entry of readdirSync(dateDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path.join(dateDir, entry.name), "utf8")) as {
        proposalId?: unknown;
        rationale?: unknown;
      };
      if (typeof parsed.proposalId === "string" && typeof parsed.rationale === "string") {
        rationales[parsed.proposalId] = parsed.rationale;
        rationales[`intent-${parsed.proposalId}`] = parsed.rationale;
      }
    } catch {
      // Ignore malformed proposal files; the review will state "未记录" for unmatched trades.
    }
  }
  return rationales;
}

function readJsonFile<T>(filePath: string, schema: z.ZodType<T>): T {
  if (!existsSync(filePath)) {
    throw new TradingDayReviewFactPackError(`Missing required memory file: ${filePath}`);
  }
  return schema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

function positionsFromSnapshotValuation(
  account: Account,
  values: unknown[],
): Position[] {
  return values.map((value) => {
    const item = value as Partial<PositionValuation>;
    return positionSchema.parse({
      accountId: account.accountId,
      symbol: item.symbol,
      market: item.market,
      name: item.name ?? item.symbol,
      quantity: item.quantity ?? 0,
      availableQuantity: item.sellableQuantity ?? 0,
      todayBuyQuantity: item.todayBuyQuantity ?? 0,
      frozenQuantity: item.frozenQuantity ?? 0,
      costPrice: item.costPrice ?? 0,
      latestPrice: item.latestPrice ?? item.costPrice ?? 0,
      currency: "CNY",
      openedAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
  });
}

function lotsFromValuationPositions(values: unknown[]): ReviewPositionLot[] {
  return values.flatMap((value) => {
    const item = value as Partial<PositionValuation>;
    if (!item.symbol || !item.market || !item.quantity || item.quantity <= 0) {
      return [];
    }
    return [{
      symbol: item.symbol,
      market: item.market,
      name: item.name ?? item.symbol,
      quantity: item.quantity,
      costPrice: item.costPrice ?? 0,
    }];
  });
}

function beijingClockLabel(iso: string): string {
  const shifted = new Date(Date.parse(iso) + BEIJING_OFFSET_MS);
  return `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`;
}

function clockMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function tradeKey(symbol: string, market: string): string {
  return `${market}:${symbol}`;
}

function normalizeIso(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TradingDayReviewFactPackError(`${label} must be a valid ISO timestamp`);
  }
  return parsed.toISOString();
}

function assertTradingDate(value: string): void {
  if (!TRADING_DATE_PATTERN.test(value)) {
    throw new TradingDayReviewFactPackError(`tradingDate must be YYYY-MM-DD, got ${value}`);
  }
}

function formatMoney(value: number): string {
  return `¥${roundMoney(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export class TradingDayReviewFactPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradingDayReviewFactPackError";
  }
}
