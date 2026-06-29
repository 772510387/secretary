import type { BrainProvider, ToolCallingProvider, TurnPlan } from "../domain/brain/index.js";
import type { Account, Position } from "../domain/portfolio/index.js";
import type { NotificationEvent } from "../domain/notification/index.js";
import type { PaperAgentTools } from "./brain-agent-tools.js";
import type { AgentAction } from "./agent-router.js";
import {
  detectPaperOpsCommand,
  formatPaperOpsCommand,
  wantsImmediatePaperExecution,
} from "./paper-ops-intent.js";
import { detectPortfolioStatusQuery, formatPortfolioStatus } from "./portfolio-status.js";
import {
  fulfilTurnPlan,
  planAgentTurn,
  planNeedsContext,
} from "./agent-planner.js";
import type {
  AskIndex,
  AskTechnical,
  AskWebSearchContext,
  MarketDataHealth,
} from "./ask-portfolio.js";
import type { PlanWatchlistEntry } from "../domain/plan/index.js";
import type { ResearchRunner } from "./run-research-once.js";
import type { PotentialStockCandidate } from "./potential-stock-analysis.js";

export interface WeChatBridgeMessage {
  peerId: string;
  text: string;
}

export interface WeChatBridgeContext {
  account?: Account;
  positions?: Position[];
  prices?: Record<string, number>;
  technicals?: AskTechnical[];
  indices?: AskIndex[];
  /** The maintained 100 高关注池 (fed to alarm nodes + the funnel). */
  watchlist?: PlanWatchlistEntry[];
  /** Rich current 潜力股池 entries for full-depth basket analysis in chat. */
  potentialStocks?: PotentialStockCandidate[];
  /** 观察池分类概览 (层级1 counts + 层级2 named picks) rendered at 换血 time. */
  poolOverview?: string;
  /** Per-candidate intraday (分时) summaries — the "精确到分" grounding for pick_stocks. */
  intradayContext?: string;
  /** 龙虎榜 (主力净买卖) summary — fetched only for 盘后 review nodes. */
  dragonTiger?: string;
  /** 持仓资金面 (Sina 主力净流入 per held position) — the 北向 replacement signal. */
  holdingsMoneyFlow?: string;
  /** 行情相位 label (集合竞价/上午盘中/…) so the brain knows what the current price means. */
  marketPhase?: string;
  /** Explicit eye health so the brain degrades honestly instead of inventing data. */
  dataHealth?: MarketDataHealth;
  webSearch?: AskWebSearchContext;
}

export interface WeChatBridgeDependencies {
  brainProvider: BrainProvider;
  /** Optional deep-research engine (TradingAgents-CN); absent = deep_research degrades to chat. */
  researchRunner?: ResearchRunner;
  /**
   * When BOTH are present, `chat` runs through the agentic tool loop (model reads on
   * demand + may place paper trades). Absent → chat stays on the read-only ask path.
   */
  agentTools?: PaperAgentTools;
  toolProvider?: ToolCallingProvider;
  /** Forwards a model-executed "操作+逻辑" notification to external channels (Feishu). */
  pushOperation?: (event: NotificationEvent) => void | Promise<void>;
  /** Whether this peer may command the bot at all. */
  isAllowed: (peerId: string) => boolean;
  /** Whether destructive ops (reset/seed) are allowed for this peer. */
  allowDestructive: (peerId: string) => boolean;
  /** Reads fresh account/positions (+ optional prices/web) for the turn. */
  loadContext: (message: string) => WeChatBridgeContext | Promise<WeChatBridgeContext>;
  /** Reads the maintained 100 高关注池 (cheap, disk-only) — needed for read-only 选股 (pick_stocks). */
  loadWatchlist?: () => PlanWatchlistEntry[] | Promise<PlanWatchlistEntry[]>;
  /** Reads the current rich 潜力股池 (cheap, disk-only) for deep basket analysis. */
  loadPotentialStocks?: () => PotentialStockCandidate[] | Promise<PotentialStockCandidate[]>;
  /** Fetches today's intraday (分时) summary text for the given symbols (网络). Used to ground pick_stocks. */
  loadIntraday?: (symbols: string[]) => string | Promise<string>;
  /** Fetches current/closing prices per symbol (网络). Used to mark holdings to market in the status query. */
  loadQuotes?: (symbols: string[]) => Record<string, number> | Promise<Record<string, number>>;
  /**
   * Optional deterministic fast-path source: reads stored account/positions from disk
   * (no network, no model). When present, plain status queries ("当前模拟盘信息") are
   * answered instantly here instead of routing through the model + analysis pipeline.
   */
  loadPortfolio?: () =>
    | { account?: Account; positions: Position[] }
    | Promise<{ account?: Account; positions: Position[] }>;
  /** Executes a confirmed action; returns a short human detail string. */
  executeAction: (action: AgentAction) => string | Promise<string>;
  /**
   * For long paper replay/ops over chat, return immediately and report completion
   * through onProgress. CLI/HTTP can keep this false to stay synchronous.
   */
  runConfirmedPaperOpsInBackground?: boolean;
  /** Optional: notify the user that a slow turn (look-up + analysis) is in progress. */
  onProgress?: (note: string) => void | Promise<void>;
  /** Optional deterministic review builder for complete/grounded trading-day reviews. */
  buildTradingDayReview?: (input: { message: string; now: string }) => string | Promise<string>;
  /** Optional test clock for deterministic relative-date commands such as "昨天". */
  now?: () => Date;
}

export interface ConversationTurn {
  user: string;
  assistant: string;
}

export interface WeChatBridgeState {
  /** Pending confirmation per peer. The caller owns/persists this across messages. */
  pending: Map<string, AgentAction>;
  /** Rolling per-peer transcript (last few turns) so follow-ups resolve referents. */
  transcripts: Map<string, ConversationTurn[]>;
}

export interface WeChatBridgeReply {
  reply: string;
}

export function createWeChatBridgeState(): WeChatBridgeState {
  return { pending: new Map(), transcripts: new Map() };
}

const MAX_HISTORY_TURNS = 4;

/**
 * One conversational turn of the WeChat bridge: maps an inbound message to a
 * reply, reusing the same model-driven planner the CLI/HTTP surfaces use.
 *
 * Routing is model-driven (`planAgentTurn`), not regex: the brain decides chat
 * vs. a named SOP vs. reset/seed, and the backend gates every consequence. Safety
 * over chat (there is no `--yes` flag): destructive ops require a follow-up "确认"
 * message, gated by an owner allowlist. Non-allowlisted peers are refused;
 * allowlisted-but-not-destructive peers can still ask read-only questions. The
 * model never executes tools and no real broker is involved.
 */
export async function runWeChatBridgeTurn(
  message: WeChatBridgeMessage,
  deps: WeChatBridgeDependencies,
  state: WeChatBridgeState,
): Promise<WeChatBridgeReply> {
  const text = message.text.trim();

  if (!deps.isAllowed(message.peerId)) {
    return { reply: "抱歉，你不在授权名单内，无法使用该助手。" };
  }

  if (!text) {
    return { reply: "请说点什么，例如：项目现在有什么能力？" };
  }

  const turnNow = (deps.now?.() ?? new Date()).toISOString();
  let abandonedNote = "";
  const pending = state.pending.get(message.peerId);

  if (pending) {
    if (isConfirmWord(text)) {
      state.pending.delete(message.peerId);
      if (pending.type === "paper_ops" && deps.runConfirmedPaperOpsInBackground) {
        runConfirmedActionInBackground(pending, deps);
        return {
          reply: `🛠️ 已受理：${describeAction(pending)}，正在后台执行。完成后会推送结果。`,
        };
      }

      if (pending.type === "paper_ops") {
        await deps.onProgress?.("🛠️ 已确认，正在补跑模拟运维并写入 paper 数据，请稍候…");
      }
      const detail = await deps.executeAction(pending);
      return { reply: `✅ 已执行：${describeAction(pending)}。${detail}`.trim() };
    }

    if (isCancelWord(text)) {
      state.pending.delete(message.peerId);
      return { reply: "已取消。" };
    }

    // Any other message abandons the pending action — but say so, don't drop it silently.
    state.pending.delete(message.peerId);
    abandonedNote = "（已放弃上一个待确认操作）\n";
  }

  // Deterministic fast-path: a "完整/接地/交易日/逐节点复盘" must be grounded in the
  // ledger, not routed to a generic model SOP that may invent missing numbers.
  if (deps.buildTradingDayReview && detectGroundedTradingDayReviewRequest(text)) {
    await deps.onProgress?.("📊 正在读取账本、成交和快照，生成接地交易日复盘…");
    const reply = await deps.buildTradingDayReview({ message: text, now: turnNow });
    recordTurn(state, message.peerId, { user: text, assistant: reply });
    return { reply: `${abandonedNote}${reply}` };
  }

  // Deterministic fast-path: a plain account-status lookup is answered from disk —
  // no model router, no networked context, no blocking analysis call (the source of
  // the "查个数据就超时" failure). 确定性归于代码.
  if (deps.loadPortfolio && detectPortfolioStatusQuery(text)) {
    try {
      const snapshot = await deps.loadPortfolio();
      if (snapshot.account) {
        const positions = snapshot.positions ?? [];
        // Mark holdings to market so 盈亏 reflects the real (close) price, not the book
        // cost. A simulated fill leaves position.latestPrice == cost; without a fresh quote
        // every holding would read 盈亏 +0.00%. Best-effort: fall back to book price on failure.
        let prices: Record<string, number> | undefined;
        if (deps.loadQuotes && positions.length > 0) {
          try {
            prices = await deps.loadQuotes(positions.map((position) => position.symbol));
          } catch {
            // keep prices undefined → formatPortfolioStatus uses the stored book price
          }
        }
        const reply = formatPortfolioStatus({ account: snapshot.account, positions, prices });
        recordTurn(state, message.peerId, { user: text, assistant: reply });
        return { reply: `${abandonedNote}${reply}` };
      }
      // No account yet → fall through to the normal path (which guides the user to
      // initialize a paper account) rather than printing an empty summary.
    } catch {
      // Any read problem → fall through to the model path instead of failing the turn.
    }
  }

  const fulfilDeps = {
    brainProvider: deps.brainProvider,
    researchRunner: deps.researchRunner,
    agentTools: deps.agentTools,
    toolProvider: deps.toolProvider,
  };
  const history = buildHistory(state.transcripts.get(message.peerId));
  const { plan } = await planAgentTurn(
    { message: text, history, now: turnNow },
    { brainProvider: deps.brainProvider },
  );

  // Only chat / SOP / deep-research turns need the (networked) DB/quote context;
  // capability and reset/seed routes are fulfilled without it, so they stay light.
  // Those slow turns get a progress ping so the user isn't left staring at silence.
  const needsContext = planNeedsContext(plan);

  if (needsContext) {
    await deps.onProgress?.(
      plan.intent === "deep_research"
        ? "🧠 已派多智能体分析团队（行情/基本面/消息面 + 多空辩论 + 风控），约需几分钟，请稍候…"
        : "🔍 收到，正在查行情、分析中，请稍候…",
    );
  }

  const context: WeChatBridgeContext = needsContext ? await deps.loadContext(text) : {};
  // 选股 (pick_stocks) needs the 100池; load it cheaply (disk-only) when not already present.
  if (plan.intent === "pick_stocks" && deps.loadWatchlist && !(context.watchlist && context.watchlist.length > 0)) {
    try {
      context.watchlist = await deps.loadWatchlist();
    } catch {
      // empty pool → fulfilPickStocks returns a friendly "池子为空" reply
    }
  }

  if (
    plan.intent === "pick_stocks" &&
    deps.loadPotentialStocks &&
    !(context.potentialStocks && context.potentialStocks.length > 0)
  ) {
    try {
      context.potentialStocks = await deps.loadPotentialStocks();
    } catch {
      // optional enrichment only
    }
  }

  // 精确到分: ground the basket analysis with today's intraday (分时) — VWAP / day range /
  // tail momentum per candidate — instead of inferring buy points from the snapshot close.
  if (plan.intent === "pick_stocks" && deps.loadIntraday && !context.intradayContext) {
    const symbols = intradaySymbolsFromContext(context);
    if (symbols.length > 0) {
      try {
        context.intradayContext = await deps.loadIntraday(symbols);
      } catch {
        // optional enrichment only — pick_stocks still works without 分时
      }
    }
  }
  const result = await fulfilTurnPlan(
    plan,
    { message: text, confirmed: false, history, now: turnNow, ...context },
    fulfilDeps,
  );

  if (!result.requiresConfirmation) {
    // A model-executed paper operation is forwarded to external channels as the
    // "操作+逻辑" message (the reply already carries it for this peer; this makes it
    // an auditable proactive push too). Best-effort — never fails the turn.
    if (result.operationNotification && deps.pushOperation) {
      await notifyOperation(deps, result.operationNotification);
    }
    recordTurn(state, message.peerId, { user: text, assistant: result.reply });
    return { reply: `${abandonedNote}${result.reply}` };
  }

  if (!deps.allowDestructive(message.peerId)) {
    return { reply: `${abandonedNote}危险操作已禁用：未配置 owner 白名单或你无此权限。` };
  }

  // Owner said "直接执行/直接落库/不用确认…就行" — run the paper op now, skipping the
  // confirm round-trip. paper-only and owner-gated (never live); honours the explicit
  // instruction instead of staging a pending confirmation for an op they already asked for.
  if (plan.intent === "paper_ops" && wantsImmediatePaperExecution(text)) {
    const immediateAction = actionFromPlan(plan, text, turnNow);
    if (immediateAction && immediateAction.type === "paper_ops") {
      if (deps.runConfirmedPaperOpsInBackground) {
        runConfirmedActionInBackground(immediateAction, deps);
        return {
          reply: `${abandonedNote}🛠️ 已直接受理：${describeAction(immediateAction)}，正在后台执行。完成后会推送结果。`,
        };
      }
      await deps.onProgress?.("🛠️ 已直接执行模拟运维，正在按时点遮掩补跑并写入 paper 数据，请稍候…");
      const detail = await deps.executeAction(immediateAction);
      recordTurn(state, message.peerId, { user: text, assistant: result.reply });
      return { reply: `${abandonedNote}✅ 已直接执行：${describeAction(immediateAction)}（paper-only）。${detail}`.trim() };
    }
  }

  // Derive the concrete action straight from the plan — no redundant second fulfil.
  const action = actionFromPlan(plan, text, turnNow);

  if (action) {
    state.pending.set(message.peerId, action);
    const reason = plan.confirmationReason ? `（${plan.confirmationReason}）\n` : "";
    return { reply: `${abandonedNote}${result.reply}\n${reason}回复『确认』执行，『取消』放弃。` };
  }

  return { reply: `${abandonedNote}${result.reply}` };
}

function actionFromPlan(plan: TurnPlan, message: string, now: string): AgentAction | undefined {
  if (plan.intent === "reset_paper") {
    return { type: "reset_paper" };
  }
  if (plan.intent === "seed_paper") {
    return { type: "seed_paper", initialCash: plan.initialCash };
  }
  if (plan.intent === "paper_ops") {
    const detected = detectPaperOpsCommand(message, now);
    const command = detected ?? {
      replayDate: plan.replayDate,
      simulateDate: plan.simulateDate,
      archiveDate: plan.archiveDate,
    };

    if (!command.replayDate && !command.simulateDate && !command.archiveDate) {
      return undefined;
    }

    return {
      type: "paper_ops",
      ...command,
    };
  }
  return undefined;
}

/** Up to 10 symbols to fetch 分时 for: the candidates being analysed first, then holdings, then pool. */
function intradaySymbolsFromContext(context: WeChatBridgeContext): string[] {
  const ordered = [
    ...(context.potentialStocks ?? []).map((candidate) => candidate.symbol),
    ...(context.positions ?? []).map((position) => position.symbol),
    ...(context.watchlist ?? []).map((entry) => entry.symbol),
  ].filter((symbol): symbol is string => typeof symbol === "string" && symbol.length > 0);
  return [...new Set(ordered)].slice(0, 10);
}

function recordTurn(state: WeChatBridgeState, peerId: string, turn: ConversationTurn): void {
  const list = state.transcripts.get(peerId) ?? [];
  list.push({ user: clip(turn.user, 200), assistant: clip(turn.assistant, 300) });
  while (list.length > MAX_HISTORY_TURNS) {
    list.shift();
  }
  state.transcripts.set(peerId, list);
}

function buildHistory(turns: ConversationTurn[] | undefined): string | undefined {
  if (!turns || turns.length === 0) {
    return undefined;
  }
  return turns.map((turn) => `用户：${turn.user}\n小蜜：${turn.assistant}`).join("\n");
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function describeAction(action: AgentAction): string {
  if (action.type === "reset_paper") {
    return "清空并重置模拟盘";
  }
  if (action.type === "paper_ops") {
    return `模拟运维（${formatPaperOpsCommand(action)}）`;
  }

  return `构建模拟盘账户${action.initialCash ? `（初始资金 ${action.initialCash} 元）` : ""}`;
}

function runConfirmedActionInBackground(action: AgentAction, deps: WeChatBridgeDependencies): void {
  void Promise.resolve()
    .then(() => deps.executeAction(action))
    .then((detail) =>
      notifyProgress(
        deps,
        `✅ 已执行：${describeAction(action)}。${String(detail).trim()}`.trim(),
      ),
    )
    .catch((error: unknown) =>
      notifyProgress(
        deps,
        `❌ ${describeAction(action)}失败：${formatBackgroundError(error)}`,
      ),
    );
}

async function notifyOperation(
  deps: WeChatBridgeDependencies,
  event: NotificationEvent,
): Promise<void> {
  try {
    await deps.pushOperation?.(event);
  } catch {
    // A push failure must not fail the chat turn — the reply already carried the op.
  }
}

async function notifyProgress(deps: WeChatBridgeDependencies, note: string): Promise<void> {
  try {
    await deps.onProgress?.(note);
  } catch {
    // The action already finished/failed; a secondary push failure must not create
    // an unhandled rejection in the chat process.
  }
}

function formatBackgroundError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.trim() || "未知错误";
  return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
}

/** Broad affirmation matcher: bare words and short "可以，执行吧" / "嗯好，确认" forms. */
function isConfirmWord(text: string): boolean {
  const t = text.trim();
  if (/^(确认(执行)?|确定|是的?|对(的)?|好的?|可以|行|嗯+|执行(吧)?|继续|没问题|ok|okay|yes|y|go|sure)[!！。.~\s]*$/i.test(t)) {
    return true;
  }
  // "可以，执行吧" / "嗯好，确认" / "对，执行"
  return t.length <= 12 && /(确认|执行|继续)/.test(t) && /^(可以|好|嗯|对|行|是|没问题|ok)/i.test(t);
}

function isCancelWord(text: string): boolean {
  return /^(取消|算了|不(用|要)?了?|别(了)?|否|先不|再想想|等等|再说|no|n|cancel|stop)[!！。.~\s]*$/i.test(text.trim());
}

function detectGroundedTradingDayReviewRequest(text: string): boolean {
  const value = text.trim();
  return (
    /trading[-_ ]day[-_ ]review/i.test(value) ||
    /(?:完整|接地|交易日|逐节点|逐格|全日).{0,12}(?:复盘|回顾|review)/iu.test(value) ||
    /(?:复盘|回顾).{0,12}(?:完整|接地|交易日|逐节点|逐格|全日)/iu.test(value)
  );
}
