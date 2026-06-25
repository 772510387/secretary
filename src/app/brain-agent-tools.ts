import { z } from "zod";
import type {
  AgentToolCall,
  AgentToolEffect,
  AgentToolExecutor,
  AgentToolResult,
  AgentToolSpec,
} from "../domain/brain/index.js";
import type { JsonValue } from "../domain/shared/index.js";

/**
 * The brain's hands & eyes, exposed as callable tools for the agentic loop.
 *
 * Read tools (get_portfolio / get_quote / get_technicals) are the "eye" — the model
 * pulls only what it needs on demand instead of being pre-stuffed with everything
 * (which is what used to blow the request size and time out).
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
