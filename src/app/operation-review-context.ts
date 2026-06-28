import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { auditEventSchema, type AuditEvent } from "../domain/audit/index.js";
import { tradeIntentReviewProposalSchema, type TradeIntentReviewProposal } from "../domain/memory/index.js";
import { dailyTradingPlanSchema, type DailyTradingPlan } from "../domain/plan/index.js";
import { roundMoney, roundRatio, tradeRecordSchema, type TradeRecord } from "../domain/portfolio/index.js";
import { orderSchema, type Order } from "../domain/trading/index.js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DEFAULT_ITEMS = 12;
const MAX_TEXT_CHARS = 360;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

const dailySummarySchema = z
  .object({
    date: z.string(),
    totalAssets: z.number().optional(),
    cash: z.number().optional(),
    marketValue: z.number().optional(),
    unrealizedPnl: z.number().optional(),
    realizedPnl: z.number().optional(),
    positions: z.number().optional(),
    generatedAt: z.string().optional()
  })
  .passthrough();

const snapshotSchema = z
  .object({
    tradingDate: z.string().optional(),
    generatedAt: z.string().optional(),
    summary: dailySummarySchema.optional(),
    valuation: z.unknown().optional()
  })
  .passthrough();

export interface OperationReviewToolQuery {
  tradingDate?: string;
  symbol?: string;
  includeRaw?: boolean;
}

export interface OperationReviewToolResult {
  ok: true;
  review: OperationReviewContext;
}

export interface BuildOperationReviewContextInput {
  memoryDir: string;
  tradingDate: string;
  symbol?: string;
  now?: Date | string;
  maxItems?: number;
}

export interface OperationReviewTrade {
  tradeId: string;
  orderId?: string;
  intentId?: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  grossAmount: number;
  fee: number;
  tax: number;
  netAmount: number;
  tradeDate: string;
  tradedAt: string;
  beijingTime: string;
  orderStatus?: string;
  orderReason?: string;
  proposalTitle?: string;
  proposalRationale?: string;
  proposalDecision?: string;
  note?: string;
}

export interface OperationReviewOrder {
  orderId: string;
  intentId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  limitPrice: number;
  type: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  beijingCreatedAt: string;
  beijingUpdatedAt: string;
  reason?: string;
}

export interface OperationReviewProposalRef {
  proposalId: string;
  intentId: string;
  title: string;
  symbol?: string;
  side?: string;
  decision: string;
  rationale?: string;
  confidence?: number;
  expectedImpact?: string;
  createdAt?: string;
  beijingCreatedAt?: string;
}

export interface OperationReviewPlanRef {
  file: string;
  generatedAt?: string;
  alarmType?: string;
  nodeSequence?: number;
  matchedSymbols: string[];
  summary: string;
}

export interface OperationReviewReportRef {
  file: string;
  reportType?: string;
  title?: string;
  generatedAt?: string;
  summary: string;
}

export interface OperationReviewAuditRef {
  eventId: string;
  eventType: string;
  createdAt: string;
  beijingCreatedAt: string;
  subject?: string;
  actorType?: string;
  summary: string;
}

export interface OperationReviewPerformance {
  currentDate: string;
  previousDate?: string;
  currentTotalAssets?: number;
  previousTotalAssets?: number;
  assetDelta?: number;
  dailyReturn?: number;
  cash?: number;
  marketValue?: number;
  realizedPnl?: number;
  unrealizedPnl?: number;
  source: "daily-summary" | "snapshot";
}

export interface OperationReviewFacts {
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  buyAmount: number;
  sellAmount: number;
  symbols: string[];
  hasMatchedProposal: boolean;
}

export interface OperationReviewContext {
  tradingDate: string;
  symbol?: string;
  generatedAt: string;
  facts: OperationReviewFacts;
  performance?: OperationReviewPerformance;
  trades: OperationReviewTrade[];
  orders: OperationReviewOrder[];
  proposals: OperationReviewProposalRef[];
  plans: OperationReviewPlanRef[];
  reports: OperationReviewReportRef[];
  auditEvents: OperationReviewAuditRef[];
  dataGaps: string[];
  rendered: string;
}

type DailySummary = z.infer<typeof dailySummarySchema>;
type SnapshotDoc = z.infer<typeof snapshotSchema>;

export function buildOperationReviewContext(input: BuildOperationReviewContextInput): OperationReviewContext {
  const tradingDate = normalizeTradingDate(input.tradingDate);
  const symbol = normalizeSymbol(input.symbol);
  const maxItems = input.maxItems ?? MAX_DEFAULT_ITEMS;
  const generatedAt = toIso(input.now ?? new Date());

  const trades = filterTradesByDateAndSymbol(readJsonLines(path.join(input.memoryDir, "portfolio", "trades.jsonl"), tradeRecordSchema), tradingDate, symbol);
  const orders = readJsonLines(path.join(input.memoryDir, "portfolio", "orders.jsonl"), orderSchema);
  const proposals = readTradeIntentProposals(path.join(input.memoryDir, "proposals", tradingDate));
  const plans = readDailyPlans(path.join(input.memoryDir, "plans", tradingDate));
  const reports = readReports(path.join(input.memoryDir, "reports", tradingDate));
  const auditEvents = readJsonLines(path.join(input.memoryDir, "logs", `audit-${tradingDate}.jsonl`), auditEventSchema);
  const summaries = readJsonLines(path.join(input.memoryDir, "portfolio", "daily-summary.jsonl"), dailySummarySchema);
  const snapshot = readOptionalJson(path.join(input.memoryDir, "portfolio", "snapshots", `${tradingDate}.json`), snapshotSchema);

  const intentIds = new Set(trades.flatMap((trade) => (trade.intentId ? [trade.intentId] : [])));
  const orderIds = new Set(trades.flatMap((trade) => (trade.orderId ? [trade.orderId] : [])));
  const relatedOrders = selectRelatedOrders(orders, tradingDate, intentIds, orderIds, symbol, maxItems);
  for (const order of relatedOrders) {
    if (order.intentId) {
      intentIds.add(order.intentId);
    }
    orderIds.add(order.orderId);
  }

  const relatedProposals = selectRelatedProposals(proposals, intentIds, symbol, maxItems);
  const proposalByIntentId = new Map(relatedProposals.map((proposal) => [`intent-${proposal.proposalId}`, proposal]));
  const orderById = new Map(relatedOrders.map((order) => [order.orderId, order]));

  const reviewTrades = trades
    .slice(0, maxItems)
    .map((trade) => toReviewTrade(trade, trade.orderId ? orderById.get(trade.orderId) : undefined, trade.intentId ? proposalByIntentId.get(trade.intentId) : undefined));
  const reviewOrders = relatedOrders.slice(0, maxItems).map(toReviewOrder);
  const reviewProposals = relatedProposals.slice(0, maxItems).map(toReviewProposalRef);
  const reviewPlans = selectRelatedPlans(plans, symbol, maxItems);
  const reviewReports = selectRelatedReports(reports, symbol, maxItems);
  const reviewAuditEvents = selectRelatedAuditEvents(auditEvents, intentIds, orderIds, symbol, maxItems);
  const performance = buildPerformance(tradingDate, summaries, snapshot);

  const facts = buildFacts(reviewTrades);
  const dataGaps = buildDataGaps({
    trades: reviewTrades,
    orders: reviewOrders,
    proposals: reviewProposals,
    performance,
    tradingDate,
    symbol
  });

  const partial: Omit<OperationReviewContext, "rendered"> = {
    tradingDate,
    ...(symbol ? { symbol } : {}),
    generatedAt,
    facts,
    ...(performance ? { performance } : {}),
    trades: reviewTrades,
    orders: reviewOrders,
    proposals: reviewProposals,
    plans: reviewPlans,
    reports: reviewReports,
    auditEvents: reviewAuditEvents,
    dataGaps
  };

  return {
    ...partial,
    rendered: renderOperationReview(partial)
  };
}

function normalizeTradingDate(value: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE_RE.test(trimmed)) {
    throw new Error(`Invalid tradingDate: ${value}`);
  }
  return trimmed;
}

function normalizeSymbol(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d{6}$/.test(trimmed)) {
    throw new Error(`Invalid symbol: ${value}`);
  }
  return trimmed;
}

function toIso(value: Date | string): string {
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  return value.toISOString();
}

function readJsonLines<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = schema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
}

function readOptionalJson<T>(file: string, schema: z.ZodType<T>): T | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readJsonFiles<T extends object>(dir: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Array<T & { __file?: string }> {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const parsed = readOptionalJson(path.join(dir, file), schema);
      return parsed ? [{ ...parsed, __file: file } as T & { __file?: string }] : [];
    });
}

function readTradeIntentProposals(dir: string): Array<TradeIntentReviewProposal & { __file?: string }> {
  return readJsonFiles<TradeIntentReviewProposal>(dir, tradeIntentReviewProposalSchema);
}

function readDailyPlans(dir: string): Array<DailyTradingPlan & { __file?: string }> {
  return readJsonFiles<DailyTradingPlan>(dir, dailyTradingPlanSchema);
}

function readReports(dir: string): Array<Record<string, unknown> & { __file?: string }> {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
        return [{ ...parsed, __file: file }];
      } catch {
        return [];
      }
    });
}

function filterTradesByDateAndSymbol(trades: TradeRecord[], tradingDate: string, symbol: string | undefined): TradeRecord[] {
  return trades
    .filter((trade) => trade.tradeDate === tradingDate)
    .filter((trade) => !symbol || trade.symbol === symbol)
    .sort((a, b) => a.tradedAt.localeCompare(b.tradedAt));
}

function selectRelatedOrders(
  orders: Order[],
  tradingDate: string,
  intentIds: Set<string>,
  orderIds: Set<string>,
  symbol: string | undefined,
  maxItems: number
): Order[] {
  const related = orders
    .filter((order) => orderIds.has(order.orderId) || intentIds.has(order.intentId) || (!!symbol && order.symbol === symbol && beijingDate(order.createdAt) === tradingDate))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return uniqueBy(related, (order) => order.orderId).slice(0, maxItems);
}

function selectRelatedProposals(
  proposals: Array<TradeIntentReviewProposal & { __file?: string }>,
  intentIds: Set<string>,
  symbol: string | undefined,
  maxItems: number
): Array<TradeIntentReviewProposal & { __file?: string }> {
  const related = proposals
    .filter((proposal) => intentIds.has(`intent-${proposal.proposalId}`) || proposalMentionsSymbol(proposal, symbol))
    .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  return uniqueBy(related, (proposal) => proposal.proposalId).slice(0, maxItems);
}

function proposalMentionsSymbol(proposal: TradeIntentReviewProposal, symbol: string | undefined): boolean {
  if (!symbol) {
    return true;
  }
  return proposal.symbol === symbol || JSON.stringify(proposal).includes(symbol);
}

function selectRelatedPlans(plans: Array<DailyTradingPlan & { __file?: string }>, symbol: string | undefined, maxItems: number): OperationReviewPlanRef[] {
  return plans
    .filter((plan) => !symbol || planMentionsSymbol(plan, symbol))
    .slice(0, maxItems)
    .map((plan) => {
      const matchedSymbols = collectSymbolsFromPlan(plan).filter((item, index, array) => array.indexOf(item) === index);
      return {
        file: plan.__file ?? "unknown.json",
        generatedAt: plan.generatedAt,
        alarmType: plan.alarmType,
        nodeSequence: plan.nodeSequence,
        matchedSymbols: symbol ? matchedSymbols.filter((item) => item === symbol) : matchedSymbols.slice(0, 8),
        summary: clipText(buildPlanSummary(plan))
      };
    });
}

function planMentionsSymbol(plan: DailyTradingPlan, symbol: string): boolean {
  return collectSymbolsFromPlan(plan).includes(symbol) || JSON.stringify(plan).includes(symbol);
}

function collectSymbolsFromPlan(plan: DailyTradingPlan): string[] {
  const symbols: string[] = [];
  for (const item of plan.shortlist10) {
    symbols.push(item.symbol);
  }
  for (const order of plan.pendingOrders) {
    symbols.push(order.symbol);
  }
  return symbols;
}

function buildPlanSummary(plan: DailyTradingPlan): string {
  const orders = plan.pendingOrders.map((order) => `${order.side} ${order.symbol}：${order.rationale}`).join("；");
  const shortlist = plan.shortlist10.map((item) => `${item.symbol}${item.name ? ` ${item.name}` : ""}：${item.rationale}`).join("；");
  return [orders ? `计划单：${orders}` : "", shortlist ? `观察：${shortlist}` : ""].filter(Boolean).join("\n");
}

function selectRelatedReports(reports: Array<Record<string, unknown> & { __file?: string }>, symbol: string | undefined, maxItems: number): OperationReviewReportRef[] {
  return reports
    .filter((report) => !symbol || JSON.stringify(report).includes(symbol))
    .slice(0, maxItems)
    .map((report) => ({
      file: report.__file ?? "unknown.json",
      reportType: stringField(report.reportType) ?? stringField(report.type),
      title: stringField(report.title),
      generatedAt: stringField(report.generatedAt),
      summary: clipText(stringField(report.summary) ?? stringField(report.contentMarkdown) ?? stringField(report.content) ?? JSON.stringify(report))
    }));
}

function selectRelatedAuditEvents(
  events: AuditEvent[],
  intentIds: Set<string>,
  orderIds: Set<string>,
  symbol: string | undefined,
  maxItems: number
): OperationReviewAuditRef[] {
  return events
    .filter((event) => auditEventIsRelated(event, intentIds, orderIds, symbol))
    .slice(0, maxItems)
    .map((event) => ({
      eventId: event.eventId,
      eventType: event.action,
      createdAt: event.occurredAt,
      beijingCreatedAt: formatBeijingDateTime(event.occurredAt),
      subject: `${event.subject.type}${event.subject.id ? `:${event.subject.id}` : ""}`,
      actorType: event.actor.type,
      summary: clipText(JSON.stringify({ message: event.message, result: event.result, metadata: event.metadata }))
    }));
}

function auditEventIsRelated(event: AuditEvent, intentIds: Set<string>, orderIds: Set<string>, symbol: string | undefined): boolean {
  const haystack = JSON.stringify(event);
  if (symbol && haystack.includes(symbol)) {
    return true;
  }
  for (const intentId of intentIds) {
    if (intentId && haystack.includes(intentId)) {
      return true;
    }
  }
  for (const orderId of orderIds) {
    if (orderId && haystack.includes(orderId)) {
      return true;
    }
  }
  return false;
}

function toReviewTrade(trade: TradeRecord, order: Order | undefined, proposal: TradeIntentReviewProposal | undefined): OperationReviewTrade {
  return {
    tradeId: trade.tradeId,
    ...(trade.orderId ? { orderId: trade.orderId } : {}),
    ...(trade.intentId ? { intentId: trade.intentId } : {}),
    symbol: trade.symbol,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    grossAmount: trade.grossAmount,
    fee: trade.fees,
    tax: trade.tax,
    netAmount: trade.netAmount,
    tradeDate: trade.tradeDate,
    tradedAt: trade.tradedAt,
    beijingTime: formatBeijingDateTime(trade.tradedAt),
    ...(order?.status ? { orderStatus: order.status } : {}),
    ...(orderReason(order) ? { orderReason: orderReason(order) } : {}),
    ...(proposal?.reviewReason ? { proposalTitle: proposal.reviewReason } : {}),
    ...(proposal?.rationale ? { proposalRationale: proposal.rationale } : {}),
    ...(proposal?.status ? { proposalDecision: proposal.status } : {}),
    ...(trade.note ? { note: trade.note } : {})
  };
}

function toReviewOrder(order: Order): OperationReviewOrder {
  return {
    orderId: order.orderId,
    intentId: order.intentId,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    limitPrice: order.limitPrice,
    type: order.type,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    beijingCreatedAt: formatBeijingDateTime(order.createdAt),
    beijingUpdatedAt: formatBeijingDateTime(order.updatedAt),
    ...(orderReason(order) ? { reason: orderReason(order) } : {})
  };
}

function toReviewProposalRef(proposal: TradeIntentReviewProposal): OperationReviewProposalRef {
  return {
    proposalId: proposal.proposalId,
    intentId: `intent-${proposal.proposalId}`,
    title: proposal.reviewReason,
    symbol: proposal.symbol,
    side: proposal.side,
    decision: proposal.status,
    ...(proposal.rationale ? { rationale: proposal.rationale } : {}),
    ...(proposal.createdAt ? { createdAt: proposal.createdAt, beijingCreatedAt: formatBeijingDateTime(proposal.createdAt) } : {})
  };
}

function orderReason(order: Order | undefined): string | undefined {
  if (!order) {
    return undefined;
  }
  const candidate = order as Order & { reason?: unknown; rationale?: unknown; note?: unknown };
  return stringField(candidate.reason) ?? stringField(candidate.rationale) ?? stringField(candidate.note);
}

function buildFacts(trades: OperationReviewTrade[]): OperationReviewFacts {
  const buyTrades = trades.filter((trade) => trade.side === "BUY");
  const sellTrades = trades.filter((trade) => trade.side === "SELL");
  return {
    tradeCount: trades.length,
    buyCount: buyTrades.length,
    sellCount: sellTrades.length,
    buyAmount: roundMoney(buyTrades.reduce((sum, trade) => sum + trade.netAmount, 0)),
    sellAmount: roundMoney(sellTrades.reduce((sum, trade) => sum + trade.netAmount, 0)),
    symbols: [...new Set(trades.map((trade) => trade.symbol))],
    hasMatchedProposal: trades.some((trade) => Boolean(trade.proposalRationale || trade.proposalTitle))
  };
}

function buildPerformance(tradingDate: string, summaries: DailySummary[], snapshot: SnapshotDoc | undefined): OperationReviewPerformance | undefined {
  const sorted = summaries.filter((summary) => ISO_DATE_RE.test(summary.date)).sort((a, b) => a.date.localeCompare(b.date));
  const current = sorted.find((summary) => summary.date === tradingDate) ?? snapshot?.summary;
  if (!current) {
    return undefined;
  }
  const previous = sorted.filter((summary) => summary.date < tradingDate && summary.totalAssets !== undefined).at(-1);
  const currentTotalAssets = current.totalAssets;
  const previousTotalAssets = previous?.totalAssets;
  const assetDelta = currentTotalAssets !== undefined && previousTotalAssets !== undefined ? roundMoney(currentTotalAssets - previousTotalAssets) : undefined;
  const dailyReturn =
    currentTotalAssets !== undefined && previousTotalAssets !== undefined && previousTotalAssets !== 0
      ? roundRatio((currentTotalAssets - previousTotalAssets) / previousTotalAssets)
      : undefined;

  return {
    currentDate: tradingDate,
    ...(previous?.date ? { previousDate: previous.date } : {}),
    ...(currentTotalAssets !== undefined ? { currentTotalAssets } : {}),
    ...(previousTotalAssets !== undefined ? { previousTotalAssets } : {}),
    ...(assetDelta !== undefined ? { assetDelta } : {}),
    ...(dailyReturn !== undefined ? { dailyReturn } : {}),
    ...(current.cash !== undefined ? { cash: current.cash } : {}),
    ...(current.marketValue !== undefined ? { marketValue: current.marketValue } : {}),
    ...(current.realizedPnl !== undefined ? { realizedPnl: current.realizedPnl } : {}),
    ...(current.unrealizedPnl !== undefined ? { unrealizedPnl: current.unrealizedPnl } : {}),
    source: summaries.some((summary) => summary.date === tradingDate) ? "daily-summary" : "snapshot"
  };
}

function buildDataGaps(input: {
  trades: OperationReviewTrade[];
  orders: OperationReviewOrder[];
  proposals: OperationReviewProposalRef[];
  performance: OperationReviewPerformance | undefined;
  tradingDate: string;
  symbol: string | undefined;
}): string[] {
  const gaps: string[] = [];
  if (input.trades.length === 0) {
    gaps.push(`未找到 ${input.tradingDate}${input.symbol ? ` ${input.symbol}` : ""} 的成交流水，无法断言当日实际买卖。`);
  }
  if (input.orders.length === 0) {
    gaps.push("未找到关联订单记录，无法核对委托状态、委托价和成交价差异。");
  }
  if (input.trades.some((trade) => !trade.proposalRationale && !trade.orderReason)) {
    gaps.push("部分成交缺少原始提案或订单理由，只能解释成交事实，不能臆造当时判断。");
  }
  if (input.trades.some((trade) => trade.side === "SELL")) {
    gaps.push("当前成交流水未保存卖出对应成本批次，单笔已实现盈亏只能用账户快照或后续成本归因计算。");
  }
  if (!input.performance) {
    gaps.push("未找到当日盘后快照或 daily-summary，无法给出账户级当日盈亏。");
  } else if (input.performance.assetDelta === undefined) {
    gaps.push("缺少上一交易日资产快照，无法计算账户级日收益率。");
  }
  if (input.proposals.length === 0 && input.trades.length > 0) {
    gaps.push("未匹配到当日提案文件，若需要复盘“为什么操作”，需要依赖订单理由、审计或人工补记。");
  }
  return gaps;
}

function renderOperationReview(context: Omit<OperationReviewContext, "rendered">): string {
  const lines: string[] = [];
  lines.push(`# 操作复盘证据包 ${context.tradingDate}${context.symbol ? ` ${context.symbol}` : ""}`);
  lines.push(`生成时间：${formatBeijingDateTime(context.generatedAt)} 北京时间`);
  lines.push("");
  lines.push(
    `成交概览：${context.facts.tradeCount} 笔，买入 ${context.facts.buyCount} 笔 / ${formatMoney(context.facts.buyAmount)}，卖出 ${context.facts.sellCount} 笔 / ${formatMoney(context.facts.sellAmount)}。`
  );
  if (context.performance) {
    const perf = context.performance;
    const perfParts = [
      perf.currentTotalAssets !== undefined ? `总资产 ${formatMoney(perf.currentTotalAssets)}` : "",
      perf.assetDelta !== undefined ? `较${perf.previousDate ?? "上一快照"} ${formatSignedMoney(perf.assetDelta)}` : "",
      perf.dailyReturn !== undefined ? `日收益 ${formatPct(perf.dailyReturn)}` : "",
      perf.cash !== undefined ? `现金 ${formatMoney(perf.cash)}` : "",
      perf.marketValue !== undefined ? `市值 ${formatMoney(perf.marketValue)}` : ""
    ].filter(Boolean);
    lines.push(`账户快照：${perfParts.join("，")}。`);
  }
  lines.push("");

  if (context.trades.length > 0) {
    lines.push("## 成交时间线");
    for (const trade of context.trades) {
      const reason = trade.proposalRationale ?? trade.orderReason ?? "未记录原始理由";
      lines.push(
        `- ${trade.beijingTime} ${trade.side === "BUY" ? "买入" : "卖出"} ${trade.symbol} ${trade.quantity}股 @ ${formatMoney(trade.price)}，净额 ${formatMoney(trade.netAmount)}，理由：${clipText(reason)}`
      );
    }
    lines.push("");
  }

  if (context.proposals.length > 0) {
    lines.push("## 关联提案");
    for (const proposal of context.proposals) {
      lines.push(
        `- ${proposal.beijingCreatedAt ?? proposal.createdAt ?? "时间未知"} ${proposal.title}：${proposal.decision}${proposal.rationale ? `；${clipText(proposal.rationale)}` : ""}`
      );
    }
    lines.push("");
  }

  if (context.plans.length > 0) {
    lines.push("## 当日计划线索");
    for (const plan of context.plans) {
      lines.push(`- ${plan.file}${plan.alarmType ? ` / ${plan.alarmType}` : ""}：${plan.summary}`);
    }
    lines.push("");
  }

  if (context.reports.length > 0) {
    lines.push("## 已生成报告");
    for (const report of context.reports) {
      lines.push(`- ${report.file}${report.title ? ` / ${report.title}` : ""}：${report.summary}`);
    }
    lines.push("");
  }

  if (context.auditEvents.length > 0) {
    lines.push("## 审计线索");
    for (const event of context.auditEvents) {
      lines.push(`- ${event.beijingCreatedAt} ${event.eventType}${event.subject ? ` ${event.subject}` : ""}：${event.summary}`);
    }
    lines.push("");
  }

  if (context.dataGaps.length > 0) {
    lines.push("## 数据缺口");
    for (const gap of context.dataGaps) {
      lines.push(`- ${gap}`);
    }
  }

  return lines.join("\n").trim();
}

function formatBeijingDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const shifted = new Date(date.getTime() + EIGHT_HOURS_MS);
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 19)}`;
}

function beijingDate(value: string): string {
  return formatBeijingDateTime(value).slice(0, 10);
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

function formatSignedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatMoney(value)}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function clipText(value: string): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length <= MAX_TEXT_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, MAX_TEXT_CHARS - 1)}...`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(item);
  }
  return output;
}
