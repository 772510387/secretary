import path from "node:path";
import {
  roundMoney,
  roundRatio,
} from "../domain/portfolio/index.js";
import { AtomicFileWriter } from "../infrastructure/storage/index.js";
import {
  buildTradingDayReviewFactPack,
  buildTradingDayReviewFactPackFromMemory,
  type BuildTradingDayReviewFactPackInput,
  type BuildTradingDayReviewFromMemoryInput,
  type ReviewDecisionNode,
  type TradingDayReviewFactPack,
} from "./build-review-factpack.js";

export interface TradingDayReview {
  factPack: TradingDayReviewFactPack;
  markdown: string;
  validation: TradingDayReviewValidation;
}

export interface TradingDayReviewValidation {
  ok: boolean;
  issues: string[];
}

export interface WriteTradingDayReviewInput {
  memoryDir: string;
  review: TradingDayReview;
  writer?: AtomicFileWriter;
}

export interface WriteTradingDayReviewResult {
  filePath: string;
  backupPath?: string;
}

export interface BuildTradingDayReviewFromMemoryResult extends TradingDayReview {
  write?: WriteTradingDayReviewResult;
}

export function createTradingDayReview(input: BuildTradingDayReviewFactPackInput): TradingDayReview {
  return createTradingDayReviewFromFactPack(buildTradingDayReviewFactPack(input));
}

export function createTradingDayReviewFromMemory(
  input: BuildTradingDayReviewFromMemoryInput & { write?: boolean; writer?: AtomicFileWriter },
): BuildTradingDayReviewFromMemoryResult {
  const review = createTradingDayReviewFromFactPack(buildTradingDayReviewFactPackFromMemory(input));
  const write = input.write ? writeTradingDayReview({ memoryDir: input.memoryDir, review, writer: input.writer }) : undefined;
  return { ...review, ...(write ? { write } : {}) };
}

export function createTradingDayReviewFromFactPack(
  factPack: TradingDayReviewFactPack,
): TradingDayReview {
  const markdown = renderTradingDayReviewMarkdown(factPack);
  return {
    factPack,
    markdown,
    validation: validateTradingDayReviewMarkdown(markdown, factPack),
  };
}

export function writeTradingDayReview(input: WriteTradingDayReviewInput): WriteTradingDayReviewResult {
  const writer = input.writer ?? new AtomicFileWriter();
  const filePath = createTradingDayReviewPath(input.memoryDir, input.review.factPack.tradingDate);
  const result = writer.write(filePath, input.review.markdown.endsWith("\n") ? input.review.markdown : `${input.review.markdown}\n`);
  return { filePath: result.filePath, backupPath: result.backupPath };
}

export function createTradingDayReviewPath(memoryDir: string, tradingDate: string): string {
  return path.join(path.resolve(memoryDir), "reviews", tradingDate, "trading-day-review.md");
}

export function renderTradingDayReviewMarkdown(fact: TradingDayReviewFactPack): string {
  const asset = fact.asset;
  const tradeRows = fact.tradeTimeline;
  const keyTrades = tradeRows.length > 0 ? tradeRows : [];
  const finalHoldingQuantity = fact.finalPositions.reduce((sum, position) => sum + position.quantity, 0);

  return [
    `# ${fact.tradingDate} 完整交易日复盘`,
    "",
    "## 最终战绩",
    `初始/期初资产：${formatMoney(asset.startAssets)}（${startSourceLabel(asset.startSource)}）`,
    `最终资产：${formatMoney(asset.endAssets)}（${endSourceLabel(asset.endSource)}）`,
    `总盈亏：${formatSignedMoney(asset.pnlAmount)} (${formatSignedPct(asset.pnlRatio)}) ${asset.pnlAmount >= 0 ? "盈利" : "亏损"}`,
    `已实现盈亏：${asset.realizedPnl === null ? "成本依据不足，未确认" : formatSignedMoney(asset.realizedPnl)}；浮动盈亏：${formatSignedMoney(asset.unrealizedPnl)}`,
    "",
    "## 操作统计",
    `- 买入：${fact.operationStats.buyCount} 次（${fact.operationStats.buyQuantity} 股，${formatMoney(fact.operationStats.buyAmount)}）`,
    `- 卖出：${fact.operationStats.sellCount} 次（${fact.operationStats.sellQuantity} 股，${formatMoney(fact.operationStats.sellAmount)}）`,
    `- 观望/持仓：${fact.operationStats.holdCount} 次`,
    `- 最终持仓：${fact.finalPositions.length} 只，合计 ${finalHoldingQuantity} 股`,
    "",
    "## 关键决策点复盘",
    ...(keyTrades.length > 0
      ? keyTrades.map((trade, index) => renderKeyTrade(index + 1, trade))
      : ["无成交记录；本日只形成观察/持仓复盘。"]),
    "",
    "## 股价走势与操作对照",
    renderPriceActionChart(fact.decisionTimeline),
    "",
    "## 策略亮点",
    ...buildStrengthLines(fact).map((line) => `- ${line}`),
    "",
    "## 可改进之处",
    ...buildImprovementLines(fact).map((line) => `- ${line}`),
    "",
    "## 每个闹钟点的完整操作逻辑",
    renderDecisionTable(fact.decisionTimeline),
    "",
    "## 数据边界",
    ...fact.dataQuality.map((line) => `- ${line}`),
    "- 本报告由确定性事实包渲染；模型不得补写成交、价格、盈亏或理由。",
  ].join("\n");
}

export function validateTradingDayReviewMarkdown(
  markdown: string,
  fact: TradingDayReviewFactPack,
): TradingDayReviewValidation {
  const expected = [
    formatMoney(fact.asset.startAssets),
    formatMoney(fact.asset.endAssets),
    formatSignedMoney(fact.asset.pnlAmount),
    String(fact.operationStats.buyCount),
    String(fact.operationStats.sellCount),
  ];
  for (const trade of fact.tradeTimeline) {
    expected.push(String(trade.quantity), formatMoney(trade.price));
  }
  const issues = expected
    .filter((value) => !markdown.includes(value))
    .map((value) => `Markdown missing fact value: ${value}`);
  return { ok: issues.length === 0, issues };
}

function renderKeyTrade(index: number, trade: {
  beijingTime: string;
  side: "BUY" | "SELL";
  symbol?: string;
  quantity: number;
  price: number;
  logic: string;
  realizedPnl?: number;
  realizedPnlUnknownQuantity: number;
}): string {
  const title = trade.side === "BUY" ? "建仓/加仓" : "减仓/止盈止损";
  const realized =
    trade.side === "SELL"
      ? trade.realizedPnl === undefined
        ? "已实现盈亏：成本依据不足，未确认"
        : `已实现盈亏：${formatSignedMoney(trade.realizedPnl)}${trade.realizedPnlUnknownQuantity > 0 ? `（另有 ${trade.realizedPnlUnknownQuantity} 股成本缺失）` : ""}`
      : `成交金额：${formatMoney(roundMoney(trade.quantity * trade.price))}`;

  return [
    `${index}. ${trade.beijingTime} ${title}`,
    `- 操作：${trade.side === "BUY" ? "买入" : "卖出"} ${trade.symbol ?? "未知标的"} ${trade.quantity} 股 @ ${formatMoney(trade.price)}`,
    `- 理由：${trade.logic}`,
    `- 结果：${realized}`,
  ].join("\n");
}

function renderPriceActionChart(nodes: readonly ReviewDecisionNode[]): string {
  const priced = nodes.filter((node) => typeof node.price === "number");
  if (priced.length === 0) {
    return "未记录可审计分时价格，跳过走势线；不会用模型补一条虚构曲线。";
  }

  return [
    "```text",
    ...priced.map((node) => {
      const marker = /买入|建仓|加仓/.test(node.action)
        ? "B"
        : /卖出|减仓|止盈|止损/.test(node.action)
          ? "S"
          : "-";
      return `${formatMoney(node.price!)} | ${marker} ${node.beijingTime} ${node.action}`;
    }),
    "```",
  ].join("\n");
}

function renderDecisionTable(nodes: readonly ReviewDecisionNode[]): string {
  if (nodes.length === 0) {
    return "无闹钟点/成交点记录。";
  }
  const lines = [
    "| 时间 | 股价 | 涨跌 | 决策 | 操作 | 背后逻辑 |",
    "| --- | ---: | ---: | --- | --- | --- |",
  ];
  for (const node of nodes) {
    lines.push(
      [
        node.beijingTime,
        node.price === undefined ? "未记录" : formatMoney(node.price),
        node.changePct === undefined ? "未记录" : formatSignedPct(node.changePct),
        escapeTable(node.decision),
        escapeTable(node.action),
        escapeTable(node.logic),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"),
    );
  }
  return lines.join("\n");
}

function buildStrengthLines(fact: TradingDayReviewFactPack): string[] {
  const lines: string[] = [];
  if (fact.asset.pnlAmount > 0) {
    lines.push(`当日资产增加 ${formatSignedMoney(fact.asset.pnlAmount)}，收益 ${formatSignedPct(fact.asset.pnlRatio)}。`);
  }
  const profitableSells = fact.tradeTimeline.filter((trade) => (trade.realizedPnl ?? 0) > 0);
  if (profitableSells.length > 0) {
    lines.push(`有 ${profitableSells.length} 笔卖出已确认盈利，卖出纪律有账可查。`);
  }
  if (fact.operationStats.buyCount === 0 && fact.operationStats.sellCount === 0) {
    lines.push("没有成交，说明当日没有把模型判断直接变成订单。");
  }
  if (lines.length === 0) {
    lines.push("本日复盘先以守住审计链为主，未把缺失数据包装成确定结论。");
  }
  return lines;
}

function buildImprovementLines(fact: TradingDayReviewFactPack): string[] {
  const lines = [...fact.dataQuality];
  if (fact.asset.realizedPnlUnknownQuantity > 0) {
    lines.push("下一步应保留跨日成本批次，保证每笔卖出都能完整还原已实现盈亏。");
  }
  if (fact.decisionTimeline.some((node) => node.logic === "未记录")) {
    lines.push("下单链路要强制把 proposal rationale 或人工理由带入成交账本。");
  }
  return lines.length > 0 ? [...new Set(lines)] : ["暂无确定性改进项；需更多成交和节点样本。"];
}

function startSourceLabel(source: string): string {
  if (source === "previous_snapshot") {
    return "前一交易日快照";
  }
  if (source === "provided") {
    return "调用方提供";
  }
  return "账户初始资金";
}

function endSourceLabel(source: string): string {
  if (source === "daily_snapshot") {
    return "当日收盘快照";
  }
  if (source === "provided") {
    return "调用方提供";
  }
  return "当前账户估值";
}

function formatMoney(value: number): string {
  return `¥${roundMoney(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedMoney(value: number): string {
  const rounded = roundMoney(value);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${formatMoney(rounded)}`;
}

function formatSignedPct(value: number): string {
  const pct = roundRatio(value) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, "/").replace(/\r?\n/g, " ");
}
