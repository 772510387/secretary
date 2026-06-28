import { z } from "zod";
import type {
  AgentToolCall,
  AgentToolEffect,
  AgentToolExecutor,
  AgentToolResult,
  AgentToolSpec,
} from "../domain/brain/index.js";
import type { JsonValue } from "../domain/shared/index.js";
import type { OperationReviewToolQuery, OperationReviewToolResult } from "./operation-review-context.js";

/**
 * The brain's hands & eyes, exposed as callable tools for the agentic loop.
 *
 * Read tools (get_portfolio / get_quote / get_technicals / market overview /
 * watchlist / auction board) are the "eye" — the model pulls only what it needs on
 * demand instead of being pre-stuffed with everything (which is what used to blow
 * the request size and time out).
 *
 * Write tools (paper_buy / paper_sell) are the "hand" — because the whole surface is a
 * database-simulated paper account (no real broker is wired), the model is trusted to
 * decide trades boldly. It only "下达购买意图"; the deterministic hand behind
 * `executePaperOrder` still validates + sizes + fills per the paper rules and writes
 * the ledger, then the caller pushes one "操作+逻辑" notification.
 */

export type PaperOrderSide = "BUY" | "SELL";
export type PaperMarket = "SSE" | "SZSE";

export interface PaperPositionView {
  symbol: string;
  market: string;
  name?: string;
  quantity: number;
  sellableQuantity: number;
  costPrice: number;
  latestPrice: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlRatio: number;
  positionRatio: number;
}

export interface PaperPortfolioView {
  accountId: string;
  availableCash: number;
  totalCash: number;
  totalAssets: number;
  totalPositionMarketValue: number;
  totalUnrealizedPnl: number;
  investedRatio: number;
  positions: PaperPositionView[];
  pricesAvailable: boolean;
  asOf?: string;
}

export interface PaperQuoteView {
  symbol: string;
  market?: string;
  name?: string;
  price: number;
  changePct?: number;
  asOf?: string;
}

export interface PaperTechnicalView {
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

export interface PaperOrderRequest {
  side: PaperOrderSide;
  symbol: string;
  market: PaperMarket;
  name?: string;
  quantity?: number;
  limitPrice?: number;
  reason: string;
}

export interface PaperOrderOutcome {
  status: "filled" | "rejected" | "blocked" | "skipped";
  reason?: string;
  quantity?: number;
  limitPrice?: number;
  idempotent?: boolean;
}

export interface PaperAgentToolDeps {
  /** The "eye" over the ledger: current account valuation + positions. */
  loadPortfolio: () => Promise<PaperPortfolioView> | PaperPortfolioView;
  /** Market-wide read-only overview from the maintained pool / market fact pack. */
  getMarketOverview?: () => Promise<MarketOverviewToolResult> | MarketOverviewToolResult;
  /** Structured query over the maintained 100 高关注池. */
  queryWatchlist?: (query: WatchlistToolQuery) => Promise<WatchlistToolResult> | WatchlistToolResult;
  /** Structured 封单 / 一字板 board from persisted pool metadata. */
  getAuctionBoard?: (query: AuctionBoardToolQuery) => Promise<WatchlistToolResult> | WatchlistToolResult;
  /** The "eye" over the market: a live quote (null when unavailable). Omit to hide the tool. */
  getQuote?: (symbol: string) => Promise<PaperQuoteView | null> | PaperQuoteView | null;
  /** Daily technicals for a symbol (MA/trend/60-day range). Omit to hide the tool. */
  getTechnicals?: (symbol: string) => Promise<PaperTechnicalView | null> | PaperTechnicalView | null;
  /** The deterministic hand: execute ONE paper BUY/SELL and return the fill outcome. */
  executePaperOrder: (order: PaperOrderRequest) => Promise<PaperOrderOutcome> | PaperOrderOutcome;
  /**
   * The deterministic replay/ops backend: re-run a past day's flow (point-in-time
   * masked, no look-ahead), backfill today's nodes, and/or archive a post-close
   * snapshot — persisting to the paper DB. Omit to hide the run_paper_ops tool.
   * Returns a human-readable summary. This is the openclaw-style "intent = the model
   * picks the tool" path for replay, replacing brittle phrase-matching regex.
   */
  executePaperOps?: (command: PaperOpsToolCommand) => Promise<string> | string;
  /** Read-only memory search (策略/复盘/教训). Omit to hide the search_memory tool. */
  searchMemory?: (query: MemorySearchToolQuery) => Promise<MemorySearchToolResult> | MemorySearchToolResult;
  /** Guarded append-only memory write. Omit to hide the remember tool. */
  rememberNote?: (note: MemoryNoteToolInput) => Promise<MemoryNoteToolResult> | MemoryNoteToolResult;
  /** Read-only named strategy knowledge base with derived metrics/cases. */
  getStrategyKnowledge?: (
    query: StrategyKnowledgeToolQuery,
  ) => Promise<StrategyKnowledgeToolResult> | StrategyKnowledgeToolResult;
  /** Read-only evidence pack for operation review / trade accountability Q&A. */
  getOperationReview?: (query: OperationReviewToolQuery) => Promise<OperationReviewToolResult> | OperationReviewToolResult;
  /** Read-only accountability fact pack for user complaints / missed coverage feedback. */
  getFeedbackAudit?: (query: FeedbackAuditToolQuery) => Promise<FeedbackAuditToolResult> | FeedbackAuditToolResult;
}

export interface PaperOpsToolCommand {
  replayDate?: string;
  simulateDate?: string;
  archiveDate?: string;
}

export interface MemorySearchToolQuery {
  query: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface MemorySearchToolResult {
  count: number;
  hits: Array<{ path: string; snippet: string; updatedAt: string; matchCount: number }>;
}

export interface MemoryNoteToolInput {
  note: string;
  tags?: string[];
  kind?: "lesson" | "observation" | "mistake" | "rule_idea";
}

export interface MemoryNoteToolResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

export interface StrategyKnowledgeToolQuery {
  strategyId?: string;
  maxCases?: number;
}

export interface StrategyKnowledgeToolResult {
  ok: boolean;
  summaryText: string;
  strategyCount?: number;
  caseCount?: number;
  decisionCount?: number;
  strategies?: JsonValue;
  cases?: JsonValue;
  notes?: string[];
}

export interface FeedbackAuditToolQuery {
  query?: string;
  from?: string;
  to?: string;
}

export interface FeedbackAuditToolResult {
  ok: boolean;
  generatedAt?: string;
  query?: string;
  range?: Record<string, JsonValue>;
  summary?: Record<string, JsonValue>;
  days?: JsonValue[];
  findings?: string[];
  evidenceRefs?: string[];
  answerGuidance?: string[];
  reason?: string;
}

export interface MarketOverviewToolResult {
  ok: boolean;
  asOf?: string;
  marketPhase?: string;
  watchlistCount?: number;
  poolOverview?: string;
  dataHealth?: Record<string, JsonValue>;
  notes?: string[];
}

export interface WatchlistToolQuery {
  priority?: "low" | "medium" | "high";
  bucket?: string;
  sector?: string;
  theme?: string;
  symbol?: string;
  text?: string;
  limit?: number;
}

export interface WatchlistToolEntry {
  symbol: string;
  market: string;
  name: string;
  priority: "low" | "medium" | "high";
  rank?: number | null;
  reason: string;
  bucket?: string | null;
  bucketLabel?: string | null;
  sector?: string | null;
  hotTheme?: string | null;
  latestPrice?: number | null;
  changePct?: number | null;
  turnoverRate?: number | null;
  amount?: number | null;
  mainNetInflow?: number | null;
  sealAmount?: number | null;
  sealVolumeLots?: number | null;
  isOneWordBoard?: boolean | null;
  consecutiveLimitUpDays?: number | null;
  dailyTrend?: string | null;
  updatedAt?: string;
}

export interface WatchlistToolResult {
  ok: boolean;
  updatedAt?: string;
  overview?: string;
  total: number;
  returned: number;
  entries: WatchlistToolEntry[];
  notes?: string[];
}

export interface AuctionBoardToolQuery {
  side?: "limit_up" | "limit_down" | "both";
  oneWordOnly?: boolean;
  minSealAmount?: number;
  limit?: number;
}

export interface PaperAgentTools {
  specs: AgentToolSpec[];
  execute: AgentToolExecutor;
}

const NO_PARAMS: JsonValue = { type: "object", properties: {}, additionalProperties: false };

const symbolArgsSchema = z
  .object({ symbol: z.string().trim().regex(/^\d{6}$/) })
  .strict();

const paperOrderArgsSchema = z
  .object({
    symbol: z.string().trim().regex(/^\d{6}$/),
    market: z.enum(["SSE", "SZSE"]).optional(),
    name: z.string().trim().min(1).max(80).optional(),
    quantity: z.number().int().positive().max(100_000_000).optional(),
    limitPrice: z.number().finite().positive().max(100_000).optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const memorySearchArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(120),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    limit: z.number().int().positive().max(8).optional(),
  })
  .strict();

const memoryNoteArgsSchema = z
  .object({
    note: z.string().trim().min(1).max(600),
    tags: z.array(z.string().trim().min(1).max(24)).max(6).optional(),
    kind: z.enum(["lesson", "observation", "mistake", "rule_idea"]).optional(),
  })
  .strict();

const strategyKnowledgeArgsSchema = z
  .object({
    strategyId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
    maxCases: z.number().int().positive().max(20).optional(),
  })
  .strict();

const feedbackAuditArgsSchema = z
  .object({
    query: z.string().trim().min(1).max(240).optional(),
    from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

const watchlistQueryArgsSchema = z
  .object({
    priority: z.enum(["low", "medium", "high"]).optional(),
    bucket: z.string().trim().min(1).max(80).optional(),
    sector: z.string().trim().min(1).max(80).optional(),
    theme: z.string().trim().min(1).max(80).optional(),
    symbol: z.string().trim().regex(/^\d{6}$/).optional(),
    text: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();

const auctionBoardArgsSchema = z
  .object({
    side: z.enum(["limit_up", "limit_down", "both"]).optional(),
    oneWordOnly: z.boolean().optional(),
    minSealAmount: z.number().finite().nonnegative().optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .strict();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const operationReviewArgsSchema = z
  .object({
    tradingDate: z.string().trim().regex(ISO_DATE_RE).optional(),
    symbol: z.string().trim().regex(/^\d{6}$/).optional(),
    includeRaw: z.boolean().optional(),
  })
  .strict();

const paperOpsArgsSchema = z
  .object({
    replayDate: z.string().trim().regex(ISO_DATE_RE).optional(),
    simulateDate: z.string().trim().regex(ISO_DATE_RE).optional(),
    archiveDate: z.string().trim().regex(ISO_DATE_RE).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.replayDate || value.simulateDate || value.archiveDate), {
    message: "至少要给 replayDate / simulateDate / archiveDate 之一",
  });

const SYMBOL_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "6 位 A 股代码，如 600519" },
  },
  required: ["symbol"],
  additionalProperties: false,
};

const PAPER_OPS_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    replayDate: { type: "string", description: "要忠实重演（按时点遮掩未来数据）的历史交易日 YYYY-MM-DD" },
    simulateDate: { type: "string", description: "要补跑当日模拟节点的日期 YYYY-MM-DD（通常是今天）" },
    archiveDate: { type: "string", description: "要归档盘后账户快照的日期 YYYY-MM-DD" },
  },
  required: [],
  additionalProperties: false,
};

const MEMORY_SEARCH_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    query: { type: "string", description: "检索关键词，如 “大盘跳水 防守” 或 “中文在线 止损”" },
    from: { type: "string", description: "可选起始日期 YYYY-MM-DD（按记忆更新时间过滤）" },
    to: { type: "string", description: "可选截止日期 YYYY-MM-DD" },
    limit: { type: "integer", description: "返回条数上限（最多 8）" },
  },
  required: ["query"],
  additionalProperties: false,
};

const MEMORY_NOTE_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    note: { type: "string", description: "要记住的一条经验/教训/观察（<=600 字）。只追加，不改任何规则。" },
    tags: { type: "array", items: { type: "string" }, description: "可选标签（<=6 个），如 [\"防守\",\"银行股\"]" },
    kind: { type: "string", enum: ["lesson", "observation", "mistake", "rule_idea"], description: "笔记类型；默认 lesson" },
  },
  required: ["note"],
  additionalProperties: false,
};

const STRATEGY_KNOWLEDGE_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    strategyId: { type: "string", description: "可选策略 ID，如 BUY-001；不填返回总览" },
    maxCases: { type: "integer", description: "最近案例/决策条数上限，最多 20" },
  },
  required: [],
  additionalProperties: false,
};

const FEEDBACK_AUDIT_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    query: { type: "string", description: "用户的问责/反馈原文，例如“上周为什么只操作两支线，其他股票你确定看了吗”" },
    from: { type: "string", description: "可选起始日期 YYYY-MM-DD；问上周时由模型换算后传入" },
    to: { type: "string", description: "可选截止日期 YYYY-MM-DD" },
  },
  required: [],
  additionalProperties: false,
};

const OPERATION_REVIEW_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    tradingDate: { type: "string", description: "要复盘的交易日 YYYY-MM-DD；不填默认今天（北京时间）" },
    symbol: { type: "string", description: "可选 6 位股票代码，只看某一只股票的操作" },
    includeRaw: { type: "boolean", description: "可选；通常不需要，默认返回整理好的证据包" },
  },
  required: [],
  additionalProperties: false,
};

const WATCHLIST_QUERY_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    priority: { type: "string", enum: ["low", "medium", "high"], description: "按优先级筛选" },
    bucket: { type: "string", description: "按池分类筛选，如 limit_up / hot_theme / hot_sector_leader / position" },
    sector: { type: "string", description: "按板块/行业包含筛选，如 半导体、通信设备" },
    theme: { type: "string", description: "按热门题材包含筛选，如 机器人、玻璃基板、AI" },
    symbol: { type: "string", description: "6 位股票代码，精确查一只" },
    text: { type: "string", description: "自由关键词，会匹配名称、代码、理由、板块、题材" },
    limit: { type: "integer", description: "返回条数上限，最多 50" },
  },
  required: [],
  additionalProperties: false,
};

const AUCTION_BOARD_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    side: { type: "string", enum: ["limit_up", "limit_down", "both"], description: "涨停封单、跌停封单或两者" },
    oneWordOnly: { type: "boolean", description: "只看一字板" },
    minSealAmount: { type: "number", description: "最小封单金额（元），如 100000000 表示 1 亿" },
    limit: { type: "integer", description: "返回条数上限，最多 50" },
  },
  required: [],
  additionalProperties: false,
};

const ORDER_PARAM_SCHEMA: JsonValue = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "6 位 A 股代码" },
    market: { type: "string", enum: ["SSE", "SZSE"], description: "交易所；不填则按代码推断" },
    name: { type: "string", description: "股票名称（可选）" },
    quantity: { type: "integer", description: "股数（100 的整数倍）；不填则由后端按仓位上限自动定量" },
    limitPrice: { type: "number", description: "限价；不填则用最新价" },
    reason: { type: "string", description: "操作逻辑：为什么买/卖，必须写清楚" },
  },
  required: ["symbol", "reason"],
  additionalProperties: false,
};

/** Builds the tool specs + executor. Read/write tools are filtered by available deps. */
export function buildPaperAgentTools(deps: PaperAgentToolDeps): PaperAgentTools {
  const specs: AgentToolSpec[] = [
    {
      name: "get_portfolio",
      description: "查看当前模拟盘账户：可用现金、总资产、持仓明细、浮动盈亏、仓位占比。",
      parameters: NO_PARAMS,
    },
  ];

  if (deps.getMarketOverview) {
    specs.push({
      name: "get_market_overview",
      description:
        "只读查看当前市场概览：观察池层级概览、板块涨幅榜、全市场成交额、数据健康等。回答盘面/9:15/大盘/板块问题前先调用。",
      parameters: NO_PARAMS,
    });
  }

  if (deps.queryWatchlist) {
    specs.push({
      name: "query_watchlist",
      description:
        "只读查询100高关注池，可按优先级、分类(bucket)、板块、题材、股票代码或关键词筛选。用于回答观察池、高优先级、AI/机器人/板块相关股票等追问。",
      parameters: WATCHLIST_QUERY_PARAM_SCHEMA,
    });
  }

  if (deps.getAuctionBoard) {
    specs.push({
      name: "get_auction_board",
      description:
        "只读查看观察池里已落库的涨停/跌停封单榜和一字板，返回股票、题材、封单金额、封单量、连板天数。用于9:15/9:25竞价、一字板、封单追问。",
      parameters: AUCTION_BOARD_PARAM_SCHEMA,
    });
  }

  if (deps.getQuote) {
    specs.push({
      name: "get_quote",
      description: "查询某只股票的最新行情（最新价/涨跌幅）。决定买卖前先看价。",
      parameters: SYMBOL_PARAM_SCHEMA,
    });
  }
  if (deps.getTechnicals) {
    specs.push({
      name: "get_technicals",
      description: "查询某只股票的日线技术面：均线(MA5/10/20)、趋势、60 日高低与位置。",
      parameters: SYMBOL_PARAM_SCHEMA,
    });
  }

  specs.push(
    {
      name: "paper_buy",
      description:
        "在模拟盘买入一只股票（立即按规则成交并写库）。你自主决策，但必须在 reason 里写清买入逻辑。不填 quantity 则后端按仓位上限自动定量。",
      parameters: ORDER_PARAM_SCHEMA,
    },
    {
      name: "paper_sell",
      description:
        "在模拟盘卖出一只持仓（立即按规则成交并写库，遵守 T+1 可卖数量）。必须在 reason 里写清卖出逻辑。",
      parameters: ORDER_PARAM_SCHEMA,
    },
  );

  if (deps.searchMemory) {
    specs.push({
      name: "search_memory",
      description:
        "检索长期记忆/复盘/教训（只读）。决策时想引用过往经验（如“上次大盘跳水怎么处理”“某股以前的操作”）先搜一下，按命中度返回片段。",
      parameters: MEMORY_SEARCH_PARAM_SCHEMA,
    });
  }
  if (deps.rememberNote) {
    specs.push({
      name: "remember",
      description:
        "把一条值得长期记住的经验/教训/观察写入长期记忆（仅追加到固定笔记文件，绝不修改任何硬规则；要改规则请走人工复核提案，不要用本工具）。",
      parameters: MEMORY_NOTE_PARAM_SCHEMA,
    });
  }

  if (deps.getStrategyKnowledge) {
    specs.push({
      name: "get_strategy_knowledge",
      description:
        "只读查看成长式策略知识库：命名策略、strategy_id 决策引用、派生胜率、案例库和增长机制。回答策略库/战略/历史胜率/某条策略是否有效时先调用。",
      parameters: STRATEGY_KNOWLEDGE_PARAM_SCHEMA,
    });
  }

  if (deps.getOperationReview) {
    specs.push({
      name: "get_operation_review",
      description:
        "只读生成某交易日操作复盘证据包：成交时间线、订单、原始提案/理由、当日计划、盘后快照、报告和审计线索。回答“今天复盘/为什么买卖/卖了多少/早上是否卖出/这条价格线怎么定/时间戳是不是北京时间”等追问时先调用。",
      parameters: OPERATION_REVIEW_PARAM_SCHEMA,
    });
  }

  if (deps.getFeedbackAudit) {
    specs.push({
      name: "get_feedback_audit",
      description:
        "只读生成问题反馈/问责事实包：检查某日期范围内观察池100覆盖、池快照、计划、提案、成交、报告证据。用户质疑“你确定看了吗/为什么只操作几支/是不是漏看/上周复盘”时先调用。",
      parameters: FEEDBACK_AUDIT_PARAM_SCHEMA,
    });
  }

  if (deps.executePaperOps) {
    specs.push({
      name: "run_paper_ops",
      description:
        "重演/补跑模拟盘流程并写库：按时点遮掩未来数据，重演某历史交易日的节点（replayDate）、补跑某日模拟节点（simulateDate）、或归档盘后账户快照（archiveDate）。仅当用户明确要求“重演/重跑/走一遍某天的流程/补跑某日/把账户落库归档”时调用；三个日期至少给一个。",
      parameters: PAPER_OPS_PARAM_SCHEMA,
    });
  }

  const execute: AgentToolExecutor = async (call: AgentToolCall): Promise<AgentToolResult> => {
    switch (call.name) {
      case "get_portfolio":
        return runGetPortfolio(deps);
      case "get_market_overview":
        return runGetMarketOverview(deps);
      case "query_watchlist":
        return runQueryWatchlist(deps, call);
      case "get_auction_board":
        return runGetAuctionBoard(deps, call);
      case "get_quote":
        return runGetQuote(deps, call);
      case "get_technicals":
        return runGetTechnicals(deps, call);
      case "paper_buy":
        return runPaperOrder(deps, call, "BUY");
      case "paper_sell":
        return runPaperOrder(deps, call, "SELL");
      case "run_paper_ops":
        return runPaperOps(deps, call);
      case "search_memory":
        return runSearchMemory(deps, call);
      case "remember":
        return runRememberNote(deps, call);
      case "get_strategy_knowledge":
        return runGetStrategyKnowledge(deps, call);
      case "get_operation_review":
        return runGetOperationReview(deps, call);
      case "get_feedback_audit":
        return runGetFeedbackAudit(deps, call);
      default:
        return errorResult(`unknown_tool:${call.name}`);
    }
  };

  return { specs, execute };
}

async function runGetPortfolio(deps: PaperAgentToolDeps): Promise<AgentToolResult> {
  const view = await deps.loadPortfolio();
  return okResult({ ok: true, portfolio: view as unknown as JsonValue });
}

async function runGetMarketOverview(deps: PaperAgentToolDeps): Promise<AgentToolResult> {
  if (!deps.getMarketOverview) {
    return errorResult("get_market_overview 不可用");
  }
  const overview = await deps.getMarketOverview();
  return okResult({ ok: true, overview: overview as unknown as JsonValue });
}

async function runQueryWatchlist(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.queryWatchlist) {
    return errorResult("query_watchlist 不可用");
  }
  const args = parseArgs(watchlistQueryArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.queryWatchlist(args.value);
  return okResult({ ok: true, result: result as unknown as JsonValue });
}

async function runGetAuctionBoard(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getAuctionBoard) {
    return errorResult("get_auction_board 不可用");
  }
  const args = parseArgs(auctionBoardArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.getAuctionBoard(args.value);
  return okResult({ ok: true, result: result as unknown as JsonValue });
}

async function runGetQuote(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getQuote) {
    return errorResult("get_quote 不可用");
  }
  const args = parseArgs(symbolArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const quote = await deps.getQuote(args.value.symbol);
  if (quote === null) {
    return okResult({ ok: true, found: false, symbol: args.value.symbol, note: "行情缺失，未取到报价" });
  }
  return okResult({ ok: true, found: true, quote: quote as unknown as JsonValue });
}

async function runGetTechnicals(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getTechnicals) {
    return errorResult("get_technicals 不可用");
  }
  const args = parseArgs(symbolArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const technicals = await deps.getTechnicals(args.value.symbol);
  if (technicals === null) {
    return okResult({ ok: true, found: false, symbol: args.value.symbol, note: "技术面数据缺失" });
  }
  return okResult({ ok: true, found: true, technicals: technicals as unknown as JsonValue });
}

async function runPaperOrder(
  deps: PaperAgentToolDeps,
  call: AgentToolCall,
  side: PaperOrderSide,
): Promise<AgentToolResult> {
  const args = parseArgs(paperOrderArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }

  const symbol = args.value.symbol;
  const market = args.value.market ?? inferMarket(symbol);
  const reason = args.value.reason?.trim() || "（模型未给出理由）";
  const order: PaperOrderRequest = {
    side,
    symbol,
    market,
    name: args.value.name,
    quantity: args.value.quantity,
    limitPrice: args.value.limitPrice,
    reason,
  };

  const outcome = await deps.executePaperOrder(order);
  const mutated = outcome.status === "filled" && outcome.idempotent !== true;
  const sideLabel = side === "BUY" ? "买入" : "卖出";
  const sized =
    outcome.quantity !== undefined && outcome.limitPrice !== undefined
      ? ` ${outcome.quantity}股@${outcome.limitPrice}`
      : "";
  const statusLabel = describeStatus(outcome);
  const nameLabel = order.name ? ` ${order.name}` : "";
  const summary = `${sideLabel} ${symbol}${nameLabel}${sized}：${statusLabel}（逻辑：${reason}）`;

  const effect: AgentToolEffect = {
    kind: side === "BUY" ? "paper_buy" : "paper_sell",
    mutated,
    summary,
    data: {
      side,
      symbol,
      market,
      name: order.name ?? null,
      reason,
      status: outcome.status,
      reasonCode: outcome.reason ?? null,
      quantity: outcome.quantity ?? null,
      limitPrice: outcome.limitPrice ?? null,
      idempotent: outcome.idempotent ?? false,
    },
  };

  return {
    content: JSON.stringify({
      ok: outcome.status === "filled",
      status: outcome.status,
      reason: outcome.reason ?? null,
      quantity: outcome.quantity ?? null,
      limitPrice: outcome.limitPrice ?? null,
      idempotent: outcome.idempotent ?? false,
    }),
    effect,
  };
}

async function runPaperOps(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.executePaperOps) {
    return errorResult("run_paper_ops 不可用");
  }
  const args = parseArgs(paperOpsArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }

  const command: PaperOpsToolCommand = {
    replayDate: args.value.replayDate,
    simulateDate: args.value.simulateDate,
    archiveDate: args.value.archiveDate,
  };
  const summary = clipSummary(await deps.executePaperOps(command));
  const effect: AgentToolEffect = {
    kind: "paper_ops",
    mutated: true,
    summary,
    data: {
      replayDate: command.replayDate ?? null,
      simulateDate: command.simulateDate ?? null,
      archiveDate: command.archiveDate ?? null,
    },
  };
  return { content: JSON.stringify({ ok: true, summary }), effect };
}

async function runSearchMemory(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.searchMemory) {
    return errorResult("search_memory 不可用");
  }
  const args = parseArgs(memorySearchArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.searchMemory({
    query: args.value.query,
    from: args.value.from,
    to: args.value.to,
    limit: args.value.limit,
  });
  return okResult({
    ok: true,
    count: result.count,
    hits: result.hits as unknown as JsonValue,
  });
}

async function runRememberNote(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.rememberNote) {
    return errorResult("remember 不可用");
  }
  const args = parseArgs(memoryNoteArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const outcome = await deps.rememberNote({
    note: args.value.note,
    tags: args.value.tags,
    kind: args.value.kind,
  });
  const effect: AgentToolEffect = {
    kind: "memory_write",
    // A note is a side-effect, not a tradeable operation — keep it OUT of the trade
    // "已执行 N 笔" push (operations = effects.filter(mutated)).
    mutated: false,
    summary: outcome.ok ? `已记入长期记忆：${clipSummary(args.value.note)}` : `记忆写入失败：${outcome.reason ?? "unknown"}`,
    data: { kind: args.value.kind ?? "lesson", ok: outcome.ok, reason: outcome.reason ?? null },
  };
  return {
    content: JSON.stringify({ ok: outcome.ok, path: outcome.path ?? null, reason: outcome.reason ?? null }),
    effect,
  };
}

async function runGetStrategyKnowledge(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getStrategyKnowledge) {
    return errorResult("get_strategy_knowledge 不可用");
  }
  const args = parseArgs(strategyKnowledgeArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.getStrategyKnowledge({
    strategyId: args.value.strategyId,
    maxCases: args.value.maxCases,
  });
  return okResult({
    ok: result.ok,
    result: result as unknown as JsonValue,
  });
}

async function runGetOperationReview(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getOperationReview) {
    return errorResult("get_operation_review 不可用");
  }
  const args = parseArgs(operationReviewArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.getOperationReview({
    tradingDate: args.value.tradingDate,
    symbol: args.value.symbol,
    ...(args.value.includeRaw !== undefined ? { includeRaw: args.value.includeRaw } : {}),
  });
  return okResult({
    ok: result.ok,
    review: result.review as unknown as JsonValue,
  });
}

async function runGetFeedbackAudit(deps: PaperAgentToolDeps, call: AgentToolCall): Promise<AgentToolResult> {
  if (!deps.getFeedbackAudit) {
    return errorResult("get_feedback_audit 不可用");
  }
  const args = parseArgs(feedbackAuditArgsSchema, call.arguments);
  if (!args.ok) {
    return errorResult(args.error);
  }
  const result = await deps.getFeedbackAudit({
    query: args.value.query,
    from: args.value.from,
    to: args.value.to,
  });
  return okResult({
    ok: result.ok,
    factPack: result as unknown as JsonValue,
  });
}

function clipSummary(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= 600 ? trimmed : `${trimmed.slice(0, 599)}…`;
}

function describeStatus(outcome: PaperOrderOutcome): string {
  switch (outcome.status) {
    case "filled":
      return outcome.idempotent ? "已成交（此前已执行，幂等跳过）" : "已成交";
    case "blocked":
      return `被风控拦截（${outcome.reason ?? "blocked"}）`;
    case "rejected":
      return `被拒单（${outcome.reason ?? "rejected"}）`;
    case "skipped":
      return `未执行（${outcome.reason ?? "skipped"}）`;
  }
}

/** A股代码 → 交易所：6/9/5 段在上交所，其余（0/3/1/2）在深交所。 */
export function inferMarket(symbol: string): PaperMarket {
  const head = symbol.charAt(0);
  return head === "6" || head === "9" || head === "5" ? "SSE" : "SZSE";
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseArgs<T>(schema: z.ZodType<T>, raw: string): ParseResult<T> {
  let json: unknown;
  try {
    json = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    return { ok: false, error: "工具参数不是合法 JSON" };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `参数校验失败：${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid"}`,
    };
  }
  return { ok: true, value: result.data };
}

function okResult(payload: Record<string, JsonValue>): AgentToolResult {
  return { content: JSON.stringify(payload) };
}

function errorResult(message: string): AgentToolResult {
  return { content: JSON.stringify({ ok: false, error: message }), isError: true };
}
