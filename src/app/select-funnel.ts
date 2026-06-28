import { brainInputSchema, type BrainProvider } from "../domain/brain/index.js";
import {
  funnelSelectionSchema,
  selectTopNByRank,
  type PlanShortlistEntry,
  type PlanWatchlistEntry,
} from "../domain/plan/index.js";
import {
  tradeIntentReviewProposalSchema,
  type TradeIntentReviewProposal,
} from "../domain/memory/index.js";
import { isMainBoardSymbol } from "../domain/market/index.js";
import type { JsonValue } from "../domain/shared/index.js";

export interface FunnelHolding {
  symbol: string;
  market: "SSE" | "SZSE";
  name: string;
}

export interface FunnelOrderCandidate {
  side: "BUY" | "SELL";
  symbol: string;
  market: "SSE" | "SZSE";
  name: string;
  latestPrice: number;
  maxQuantity: number;
  estimatedAmount: number;
  rationale?: string;
}

export interface FunnelExecutionConstraints {
  buyCandidates?: FunnelOrderCandidate[];
  sellCandidates?: FunnelOrderCandidate[];
  maxBuyOrders?: number;
  maxSellOrders?: number;
}

export interface SelectFunnelInput {
  accountId: string;
  asOf: string;
  /** The 100 高关注池 snapshot (authoritative universe for this selection). */
  watchlist100: PlanWatchlistEntry[];
  /** Current holdings (a SELL may only target a held symbol). */
  holdings: FunnelHolding[];
  /** De-identified as-of context (candidate technicals etc.) fed to the model. */
  brainContext?: Record<string, JsonValue>;
  /** 观察池分类概览 (层级1+层级2, with real signals: 涨停/封单/连板/资金面/题材/趋势) — fed so the
   * model's selection rationale cites concrete deterministic signals instead of "排名靠前". */
  poolOverview?: string;
  /** Backend-sized executable candidates. When present, orders are constrained to these lists. */
  executionConstraints?: FunnelExecutionConstraints;
  shortlistSize?: number;
}

export interface SelectFunnelResult {
  shortlist10: PlanShortlistEntry[];
  /** 待买/待卖 — review-required, executable:false. The model proposes; execution is gated (P4). */
  proposals: TradeIntentReviewProposal[];
  degraded: boolean;
}

const DEFAULT_SHORTLIST_SIZE = 10;
const DEFAULT_MAX_BUY_ORDERS = 2;
const DEFAULT_MAX_SELL_ORDERS = 2;

/**
 * Stage B of the funnel: the model picks a shortlist (潜力股) + buy/sell candidates
 * (待买卖) from the 100-pool + current holdings. The model ONLY proposes symbols/sides;
 * the backend then:
 *  - intersects every pick with the REAL 100-pool keys (a BUY/shortlist symbol must be in
 *    the pool; a SELL must be a held symbol) — no model-injected codes can slip through;
 *  - turns buy/sell picks into review-required TradeIntentReviewProposals (executable:false,
 *    no quantity/price — sizing is deterministic at the gated execution step, not the model's);
 *  - falls back to the deterministic top-N shortlist if the model output is unusable.
 * No execution, no account write here.
 */
export async function selectFunnelStage(
  input: SelectFunnelInput,
  deps: { brainProvider: BrainProvider },
): Promise<SelectFunnelResult> {
  const shortlistSize = input.shortlistSize ?? DEFAULT_SHORTLIST_SIZE;
  const poolBySymbol = new Map(input.watchlist100.map((entry) => [entry.symbol, entry]));
  const heldBySymbol = new Map(input.holdings.map((holding) => [holding.symbol, holding]));
  const buyCandidateBySymbol = candidateMap(input.executionConstraints?.buyCandidates, "BUY");
  const sellCandidateBySymbol = candidateMap(input.executionConstraints?.sellCandidates, "SELL");
  const buyCandidatesConstrained = input.executionConstraints?.buyCandidates !== undefined;
  const sellCandidatesConstrained = input.executionConstraints?.sellCandidates !== undefined;
  const maxBuyOrders = input.executionConstraints?.maxBuyOrders ?? DEFAULT_MAX_BUY_ORDERS;
  const maxSellOrders = input.executionConstraints?.maxSellOrders ?? DEFAULT_MAX_SELL_ORDERS;

  const selection = await askModel(input, deps.brainProvider);

  if (selection === null) {
    return {
      shortlist10: selectTopNByRank(input.watchlist100, shortlistSize),
      proposals: [],
      degraded: true,
    };
  }

  // Shortlist: keep only picks that are genuinely in the 100-pool, dedup, cap.
  const shortlist10: PlanShortlistEntry[] = [];
  const seenShortlist = new Set<string>();
  for (const pick of selection.shortlist) {
    const entry = poolBySymbol.get(pick.symbol);
    if (entry === undefined || seenShortlist.has(entry.symbol) || shortlist10.length >= shortlistSize) {
      continue;
    }
    seenShortlist.add(entry.symbol);
    shortlist10.push({
      symbol: entry.symbol,
      market: entry.market,
      name: entry.name,
      rank: entry.rank,
      rationale: pick.rationale,
    });
  }
  const finalShortlist =
    shortlist10.length > 0 ? shortlist10 : selectTopNByRank(input.watchlist100, shortlistSize);

  // Orders: BUY must be in the pool; SELL must be a held symbol. Dedup by symbol+side.
  const proposals: TradeIntentReviewProposal[] = [];
  const seenOrders = new Set<string>();
  let buyOrderCount = 0;
  let sellOrderCount = 0;
  for (const order of selection.orders) {
    const poolEntry = poolBySymbol.get(order.symbol);
    const heldEntry = heldBySymbol.get(order.symbol);
    const candidate =
      order.side === "BUY" ? buyCandidateBySymbol.get(order.symbol) : sellCandidateBySymbol.get(order.symbol);
    const target = candidate ?? poolEntry ?? heldEntry;

    if (order.side === "BUY" && poolEntry === undefined) {
      continue; // can't propose buying something outside the maintained pool
    }
    if (order.side === "BUY" && buyCandidatesConstrained && candidate === undefined) {
      continue;
    }
    // 主板-only 红线（禁科创688/创业300）— defensive: the pool is already main-board, but a BUY
    // must never reach a proposal for a non-tradable board even if the pool somehow drifted.
    if (order.side === "BUY" && !isMainBoardSymbol(order.symbol)) {
      continue;
    }
    if (order.side === "SELL" && heldEntry === undefined) {
      continue; // can't propose selling something not held
    }
    if (order.side === "SELL" && sellCandidatesConstrained && candidate === undefined) {
      continue;
    }
    if (target === undefined) {
      continue;
    }
    if (order.side === "BUY" && buyOrderCount >= maxBuyOrders) {
      continue;
    }
    if (order.side === "SELL" && sellOrderCount >= maxSellOrders) {
      continue;
    }
    const dedupKey = `${order.symbol}:${order.side}`;
    if (seenOrders.has(dedupKey)) {
      continue;
    }
    seenOrders.add(dedupKey);
    if (order.side === "BUY") {
      buyOrderCount += 1;
    } else {
      sellOrderCount += 1;
    }

    proposals.push(
      buildProposal({
        accountId: input.accountId,
        asOf: input.asOf,
        symbol: target.symbol,
        market: target.market,
        name: target.name,
        side: order.side,
        rationale: order.rationale,
        quantity: candidate?.maxQuantity,
        limitPrice: candidate?.latestPrice,
        estimatedAmount: candidate?.estimatedAmount,
      }),
    );
  }

  return { shortlist10: finalShortlist, proposals, degraded: false };
}

async function askModel(
  input: SelectFunnelInput,
  brainProvider: BrainProvider,
): Promise<{ shortlist: { symbol: string; rationale: string }[]; orders: { symbol: string; side: "BUY" | "SELL"; rationale: string }[] } | null> {
  try {
    const poolList = input.watchlist100
      .map((entry) => `${entry.symbol} ${entry.name}${entry.rank !== null ? `(第${entry.rank}名)` : ""}`)
      .join("、");
    const heldList = input.holdings.map((h) => `${h.symbol} ${h.name}`).join("、") || "（空仓）";
    const buyCandidateList = formatCandidates(input.executionConstraints?.buyCandidates);
    const sellCandidateList = formatCandidates(input.executionConstraints?.sellCandidates);
    const maxBuyOrders = input.executionConstraints?.maxBuyOrders ?? DEFAULT_MAX_BUY_ORDERS;
    const maxSellOrders = input.executionConstraints?.maxSellOrders ?? DEFAULT_MAX_SELL_ORDERS;

    const output = await brainProvider.generate(
      brainInputSchema.parse({
        requestId: `funnel-select-${Date.parse(input.asOf)}`.slice(0, 128),
        taskType: "user_query",
        prompt: [
          "你只能在后端给出的【可执行买入候选】和【可执行卖出候选】里选择操作；候选已经按主板、现金、仓位、100股买入、T+1可卖过滤。",
          `BUY最多输出${maxBuyOrders}笔，SELL最多输出${maxSellOrders}笔；不要输出候选清单外的买卖。`,
          "你是只读的选股助手。从给定的【100 支高关注池】里挑出最多 10 支潜力股,",
          "并结合【当前持仓】给出待买/待卖候选(buy 只能选池内标的,sell 只能选已持有标的)。",
          "只能依据 context 里这个时点及更早的信息,绝不能假设未来走势。",
          "你只输出结构化判断，不下单、不写账户；数量和价格采用后端可执行候选里的预计算结果。",
          "在输出 JSON 的 structured 字段放:",
          '{"shortlist":[{"symbol":"6位代码","rationale":"一句话理由"}],"orders":[{"symbol":"6位代码","side":"BUY|SELL","rationale":"一句话理由"}]}',
          ...(input.poolOverview && input.poolOverview.trim()
            ? [`【观察池分类概览（确定性筛选，含真实信号：涨停/封单/连板/资金面/题材/趋势）】\n${input.poolOverview.trim()}`]
            : []),
          `100 支高关注池:${poolList || "（空）"}`,
          `当前持仓:${heldList}`,
          `可执行买入候选:${buyCandidateList}`,
          `可执行卖出候选:${sellCandidateList}`,
          "【理由硬约束】每只潜力股、每笔待买/待卖的 rationale 必须援引上面观察池概览里【该股的真实信号】(题材/主力净流入/涨停或连板/封单/日线趋势/涨幅榜位置等)至少一项，具体到数字或标签，严禁写“排名靠前/值得关注/情绪高”这类泛泛之词。",
          "【防幻觉】只能解读上面已列出的池内标的与已给数字，严禁臆造池外代码，严禁编造未提供的价格/资金/涨幅数字。",
        ].join("\n"),
        context: {
          asOf: input.asOf,
          accountId: input.accountId,
          poolSymbols: input.watchlist100.map((entry) => entry.symbol),
          heldSymbols: input.holdings.map((holding) => holding.symbol),
          executableBuyCandidates: (input.executionConstraints?.buyCandidates ?? []).map(candidateContext),
          executableSellCandidates: (input.executionConstraints?.sellCandidates ?? []).map(candidateContext),
          maxBuyOrders,
          maxSellOrders,
          ...(input.brainContext ?? {}),
        },
        constraints: {
          locale: "zh-CN",
          timezone: "Asia/Shanghai",
          outputFormat: "json",
          toolPermissions: [],
        },
        createdAt: input.asOf,
      }),
    );
    const parsed = funnelSelectionSchema.safeParse(output.structured);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function buildProposal(input: {
  accountId: string;
  asOf: string;
  symbol: string;
  market: "SSE" | "SZSE";
  name: string;
  side: "BUY" | "SELL";
  rationale: string;
  quantity?: number;
  limitPrice?: number;
  estimatedAmount?: number;
}): TradeIntentReviewProposal {
  const stamp = input.asOf.replace(/[^0-9]/g, "").slice(0, 14);
  const sized = input.quantity !== undefined && input.limitPrice !== undefined;
  return tradeIntentReviewProposalSchema.parse({
    proposalId: `funnelprop-${input.accountId}-${input.symbol}-${input.side}-${stamp}`.slice(0, 128),
    proposalType: "trade_intent_review",
    status: "pending_review",
    source: {
      sourceType: "brain_tool_request",
      requestId: `funnel-select-${stamp}`,
      toolType: "propose_trade_intent",
    },
    symbol: input.symbol,
    market: input.market,
    name: input.name,
    side: input.side,
    quantity: input.quantity,
    limitPrice: input.limitPrice,
    currency: "CNY",
    rationale: input.rationale,
    reviewReason: sized
      ? "选股漏斗候选：模型只选择方向和标的；数量与价格由后端可执行候选预计算，模型不下单。"
      : "选股漏斗候选：待后端按风控确定数量和价格，模型不下单。",
    createdAt: input.asOf,
    updatedAt: input.asOf,
    createdBy: { type: "system", id: "funnel-selector" },
    metadata: {
      funnel: true,
      ...(sized
        ? {
            executionCandidate: true,
            estimatedAmount: input.estimatedAmount ?? input.quantity! * input.limitPrice!,
          }
        : {}),
    },
  });
}

function candidateMap(
  candidates: FunnelOrderCandidate[] | undefined,
  side: "BUY" | "SELL",
): Map<string, FunnelOrderCandidate> {
  const result = new Map<string, FunnelOrderCandidate>();
  for (const candidate of candidates ?? []) {
    if (
      candidate.side === side &&
      candidate.maxQuantity > 0 &&
      Number.isFinite(candidate.latestPrice) &&
      candidate.latestPrice > 0 &&
      !result.has(candidate.symbol)
    ) {
      result.set(candidate.symbol, candidate);
    }
  }
  return result;
}

function formatCandidates(candidates: FunnelOrderCandidate[] | undefined): string {
  if (candidates === undefined) {
    return "（未提供）";
  }
  if (candidates.length === 0) {
    return "（无可执行候选）";
  }
  return candidates
    .map(
      (candidate) =>
        `${candidate.symbol} ${candidate.name} ${candidate.maxQuantity}股@${candidate.latestPrice} 约${candidate.estimatedAmount}元`,
    )
    .join("、");
}

function candidateContext(candidate: FunnelOrderCandidate): Record<string, JsonValue> {
  return {
    symbol: candidate.symbol,
    market: candidate.market,
    name: candidate.name,
    side: candidate.side,
    latestPrice: candidate.latestPrice,
    maxQuantity: candidate.maxQuantity,
    estimatedAmount: candidate.estimatedAmount,
    rationale: candidate.rationale ?? "",
  };
}
