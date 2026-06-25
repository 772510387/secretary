import {
  buildTurnPlannerBrainInput,
  parseTurnPlan,
  turnPlanNeedsContext,
  type AgentToolEffect,
  type BrainProvider,
  type ToolCallingProvider,
  type TurnPlan,
  type TurnPlanIntent,
} from "../domain/brain/index.js";
import type { NotificationEvent } from "../domain/notification/index.js";
import {
  buildBrainOperationNotification,
  runBrainAgentTurn,
} from "./run-brain-agent.js";
import type { PaperAgentTools } from "./brain-agent-tools.js";
import {
  buildCerebellumAlarmSopByType,
  renderCerebellumAlarmSop,
  resolveSopByName,
  sopCatalogForPrompt,
  type CerebellumAlarmSop,
  type SopCatalogEntry,
} from "../domain/cerebellum/index.js";
import type { Account, Position } from "../domain/portfolio/index.js";
import {
  AgentRouterError,
  CAPABILITIES_REPLY,
  type AgentAction,
} from "./agent-router.js";
import {
  runAskOnce,
  type AskIndex,
  type AskPortfolioResult,
  type AskTechnical,
  type AskWebSearchContext,
} from "./ask-portfolio.js";
import { runResearchOnce, type ResearchRunner } from "./run-research-once.js";
import { classifyAgentIntent } from "./agent-router.js";
import type { ResearchReport } from "../domain/research/index.js";
import {
  detectPaperOpsCommand,
  formatPaperOpsCommand,
  type PaperOpsCommand,
} from "./paper-ops-intent.js";

export type PlannedAgentIntent = TurnPlanIntent;

/** Extra model attempts after a structured-output parse miss, before deterministic fallback. */
const TURN_PLAN_MAX_RETRIES = 1;

export interface AgentPlannerDependencies {
  brainProvider: BrainProvider;
  /** Optional deep-research engine (TradingAgents-CN). When absent, deep_research degrades to chat. */
  researchRunner?: ResearchRunner;
  /**
   * When BOTH are present, `chat` turns run through the agentic tool loop (the model
   * reads on-demand and may place paper trades) instead of the single read-only ask.
   * Absent → chat stays on the read-only `runAskOnce` path (unchanged behaviour).
   */
  agentTools?: PaperAgentTools;
  toolProvider?: ToolCallingProvider;
}

export interface PlanAgentTurnInput {
  message: string;
  now?: string;
  /** Whether a paper account exists; helps the model route account questions. */
  hasAccount?: boolean;
  /** Compact recent conversation, so routing can resolve referents/follow-ups. */
  history?: string;
}

export type TurnRoutedBy = "model" | "fallback" | "fast_path";

export interface AgentTurnPlanning {
  plan: TurnPlan;
  /**
   * "fast_path" = a bare greeting answered without any model call; "model" = the
   * brain produced a usable route; "fallback" = the deterministic net after a
   * model failure.
   */
  routedBy: TurnRoutedBy;
}

export interface FulfilTurnPlanInput {
  message: string;
  /** True once the user has explicitly confirmed a state-changing action. */
  confirmed?: boolean;
  /** Compact recent conversation passed to the answer model for follow-ups. */
  history?: string;
  account?: Account;
  positions?: Position[];
  prices?: Record<string, number>;
  technicals?: AskTechnical[];
  indices?: AskIndex[];
  webSearch?: AskWebSearchContext;
  now?: string;
}

export interface PlannedAgentTurnResult {
  intent: PlannedAgentIntent;
  reply: string;
  requiresConfirmation: boolean;
  action?: AgentAction;
  ask?: AskPortfolioResult;
  sopName?: string;
  routedBy?: TurnRoutedBy;
  /** Paper operations the model executed this turn (agentic chat only). */
  operations?: AgentToolEffect[];
  /** A ready-to-push "操作+逻辑" notification when operations happened, else absent. */
  operationNotification?: NotificationEvent;
}

/**
 * Model-driven turn routing: asks the brain to classify one message into an
 * intent (and, for SOP requests, pick a SOP by name). The model decides by
 * meaning — no regex. If the model is unavailable or returns an unusable shape,
 * it falls back to the deterministic `classifyAgentIntent` so behaviour degrades
 * to today's rules rather than failing. State-changing intents are always forced
 * to require confirmation regardless of what the model said.
 */
export async function planAgentTurn(
  input: PlanAgentTurnInput,
  dependencies: AgentPlannerDependencies,
): Promise<AgentTurnPlanning> {
  const message = input.message.trim();

  if (!message) {
    throw new AgentRouterError("message must not be empty");
  }

  // A bare greeting is unambiguous and concrete — answer it instantly, with no
  // model round-trip. Anything beyond a pure greeting still goes to the model.
  if (looksLikeSmalltalk(message)) {
    return { plan: { intent: "smalltalk", requiresConfirmation: false }, routedBy: "fast_path" };
  }

  const paperOps = detectPaperOpsCommand(message, input.now);
  if (paperOps) {
    return {
      plan: { intent: "paper_ops", requiresConfirmation: true, ...paperOps },
      routedBy: "fast_path",
    };
  }

  // Model routing with a bounded self-correction retry (borrowed from openclaw's
  // "validation error → feed it back → the model fixes it" loop): when the structured
  // output doesn't parse into a TurnPlan, tell the model what was wrong and ask once
  // more before degrading to the deterministic rules — instead of silently falling back
  // on the first miss (which left the model unaware it had misrouted).
  let correction: string | undefined;
  for (let attempt = 0; attempt <= TURN_PLAN_MAX_RETRIES; attempt += 1) {
    let plan: TurnPlan | null = null;
    try {
      const output = await dependencies.brainProvider.generate(
        buildTurnPlannerBrainInput({
          message,
          now: input.now,
          hasAccount: input.hasAccount,
          history: input.history,
          sopCatalog: sopCatalogForPrompt(),
          correction,
        }),
      );
      plan = parseTurnPlan(output);
    } catch {
      // Provider error → retrying the same call won't help; degrade to rules.
      break;
    }

    if (plan) {
      return { plan: normalizePlan(plan), routedBy: "model" };
    }
    correction = "上次输出的 structured 不是合法路由：intent 缺失或不在枚举内，或 JSON 结构不匹配。";
  }

  return { plan: fallbackPlan(message, input.now), routedBy: "fallback" };
}

/**
 * Executes a routed plan. Read-only/Q&A intents go straight through; SOP requests
 * reuse the same read-only ask path with a SOP-derived prompt; state-changing
 * intents (reset/seed) return an `action` only and require confirmation. The
 * model never executes tools and no real broker is involved.
 */
export async function fulfilTurnPlan(
  plan: TurnPlan,
  input: FulfilTurnPlanInput,
  dependencies: AgentPlannerDependencies,
): Promise<PlannedAgentTurnResult> {
  switch (plan.intent) {
    case "smalltalk":
      return fulfilSmalltalk(plan);

    case "capabilities":
      return { intent: "capabilities", reply: CAPABILITIES_REPLY, requiresConfirmation: false };

    case "reset_paper":
      return fulfilReset(input.confirmed === true);

    case "seed_paper":
      return fulfilSeed(plan.initialCash, input.confirmed === true);

    case "paper_ops":
      return fulfilPaperOps(plan, input);

    case "run_sop":
      return fulfilSop(plan, input, dependencies);

    case "deep_research":
      return fulfilDeepResearch(plan, input, dependencies);

    case "chat":
      return fulfilChat(input, dependencies);
  }
}

/** Plan + fulfil in one call, for callers that already hold the turn context. */
export async function runPlannedAgentTurn(
  input: FulfilTurnPlanInput & { hasAccount?: boolean },
  dependencies: AgentPlannerDependencies,
): Promise<PlannedAgentTurnResult> {
  const planning = await planAgentTurn(
    {
      message: input.message,
      now: input.now,
      hasAccount: input.account ? true : input.hasAccount,
      history: input.history,
    },
    dependencies,
  );
  const result = await fulfilTurnPlan(planning.plan, input, dependencies);
  return { ...result, routedBy: planning.routedBy };
}

/** Whether this plan's fulfilment needs the (networked) account + market context. */
export function planNeedsContext(plan: TurnPlan): boolean {
  return turnPlanNeedsContext(plan.intent);
}

const RESET_WARN =
  "⚠️ 这会清空模拟盘的账户、持仓和成交记录，重置为初始状态。确认后再执行（模拟盘数据，未接真实券商）。";
const RESET_DONE = "✅ 已清空模拟盘并重置为初始状态（模拟盘数据，未接真实券商）。";

function fulfilReset(confirmed: boolean): PlannedAgentTurnResult {
  if (!confirmed) {
    return { intent: "reset_paper", reply: RESET_WARN, requiresConfirmation: true };
  }

  return {
    intent: "reset_paper",
    reply: RESET_DONE,
    requiresConfirmation: false,
    action: { type: "reset_paper" },
  };
}

function fulfilSeed(initialCash: number | undefined, confirmed: boolean): PlannedAgentTurnResult {
  const cashText = initialCash ? `，初始资金 ${initialCash} 元` : "";

  if (!confirmed) {
    return {
      intent: "seed_paper",
      reply: `⚠️ 将（重新）构建模拟盘账户${cashText}。这是模拟盘数据，按红线不接真实券商。确认后再执行。`,
      requiresConfirmation: true,
    };
  }

  return {
    intent: "seed_paper",
    reply: `✅ 已构建模拟盘账户${cashText}（模拟盘数据，未接真实券商）。`,
    requiresConfirmation: false,
    action: { type: "seed_paper", initialCash },
  };
}

function fulfilPaperOps(plan: TurnPlan, input: FulfilTurnPlanInput): PlannedAgentTurnResult {
  const command = resolvePaperOpsCommand(plan, input);
  if (!hasPaperOpsCommand(command)) {
    return {
      intent: "paper_ops",
      reply:
        "我识别到你想执行模拟运维，但没能确定具体动作和日期。请明确说明，例如：『模拟昨天的操作』或『重演昨天、更新数据库、再模拟今天』。",
      requiresConfirmation: false,
    };
  }

  const detail = formatPaperOpsCommand(command);

  if (input.confirmed !== true) {
    return {
      intent: "paper_ops",
      reply: [
        `⚠️ 将执行模拟运维：${detail}。`,
        "执行内容可能包括：补跑历史节点、写入模拟盘计划/提案/纸面成交、归档盘后账户快照。",
        "成交按后端现金、仓位、T+1、100股、主板规则定。",
        "确认后再执行。",
      ].join("\n"),
      requiresConfirmation: true,
    };
  }

  return {
    intent: "paper_ops",
    reply: `✅ 已确认执行模拟运维：${detail}（paper-only）。`,
    requiresConfirmation: false,
    action: { type: "paper_ops", ...command },
  };
}

const DEFAULT_SMALLTALK_REPLY =
  "你好，我是你的盯盘小助手小蜜 🍯。想看盘就说『现在盘面怎么样』，想复盘说『来个收盘复盘』，也可以直接问我持仓和风险。";

/**
 * Smalltalk is answered from the route call's `reply` — no second model round-trip,
 * so greetings stay fast and never depend on a fragile follow-up generation. If the
 * model didn't supply a reply (or we fell back deterministically), use a friendly default.
 */
function fulfilSmalltalk(plan: TurnPlan): PlannedAgentTurnResult {
  const reply = plan.reply?.trim();

  return {
    intent: "smalltalk",
    reply: reply && reply.length > 0 ? reply : DEFAULT_SMALLTALK_REPLY,
    requiresConfirmation: false,
  };
}

async function fulfilDeepResearch(
  plan: TurnPlan,
  input: FulfilTurnPlanInput,
  dependencies: AgentPlannerDependencies,
): Promise<PlannedAgentTurnResult> {
  // Deep research is opt-in: without a configured engine, fall back to a quick answer.
  if (!dependencies.researchRunner) {
    return fulfilChat(input, dependencies);
  }

  const target = resolveResearchTarget(plan, input);

  if (!target) {
    throw new AgentRouterError(
      "没有可深度分析的标的：请先建账户并持仓，或直接点名（例如“深度分析 风华高科 000636”）。",
    );
  }

  const tradingDate = (input.now ?? new Date().toISOString()).slice(0, 10);
  const result = await runResearchOnce({
    symbol: target.symbol,
    market: target.market,
    name: target.name,
    tradingDate,
    objective: input.message.slice(0, 1000),
    runner: dependencies.researchRunner,
    now: input.now,
    metadata: { source: "agent-planner-deep-research" },
  });

  // When analyzing a holding (not a named stock) and there are others, say so —
  // deep research is one stock per turn.
  const others = (input.positions ?? []).filter((position) => position.symbol !== target.symbol);
  const note =
    !plan.symbol && others.length > 0
      ? `\n（本次先深度分析 ${target.name ?? target.symbol}；想看其它持仓请单独说，如“深度分析 ${others[0].name ?? others[0].symbol}”。）`
      : "";

  return {
    intent: "deep_research",
    reply: formatResearchReply(result.report, target) + note,
    requiresConfirmation: false,
  };
}

async function fulfilChat(
  input: FulfilTurnPlanInput,
  dependencies: AgentPlannerDependencies,
): Promise<PlannedAgentTurnResult> {
  if (!input.account) {
    throw new AgentRouterError(
      "尚无模拟盘账户，无法回答账户类问题；请先初始化（例如：构建一个模拟盘账户）。",
    );
  }

  // Agentic path: the model reads on-demand and may place paper trades. Only when the
  // caller wired tool deps + a tool-calling provider; otherwise the read-only ask below.
  if (dependencies.agentTools && dependencies.toolProvider) {
    return fulfilChatAgentic(input, dependencies.agentTools, dependencies.toolProvider);
  }

  const ask = await runAskOnce(
    {
      question: input.message,
      account: input.account,
      positions: input.positions ?? [],
      prices: input.prices,
      technicals: input.technicals,
      indices: input.indices,
      webSearch: input.webSearch,
      history: input.history,
      now: input.now,
      metadata: { source: "agent-planner" },
    },
    { brainProvider: dependencies.brainProvider },
  );

  return { intent: "chat", reply: ask.answer, requiresConfirmation: false, ask };
}

/**
 * Agentic chat: runs the bounded tool loop so the model pulls only the data it needs
 * (no pre-stuffing → the over-sized-request timeout goes away) and can place paper
 * trades itself. Any executed operations come back as a pushable "操作+逻辑"
 * notification for the caller to forward.
 */
async function fulfilChatAgentic(
  input: FulfilTurnPlanInput,
  tools: PaperAgentTools,
  provider: ToolCallingProvider,
): Promise<PlannedAgentTurnResult> {
  const result = await runBrainAgentTurn({
    question: input.message,
    provider,
    tools,
    history: input.history,
    now: input.now,
  });

  const operationNotification =
    buildBrainOperationNotification({
      operations: result.operations,
      answer: result.answer,
      accountId: input.account?.accountId,
      now: input.now,
    }) ?? undefined;

  return {
    intent: "chat",
    reply: result.answer,
    requiresConfirmation: false,
    operations: result.operations,
    ...(operationNotification ? { operationNotification } : {}),
  };
}

async function fulfilSop(
  plan: TurnPlan,
  input: FulfilTurnPlanInput,
  dependencies: AgentPlannerDependencies,
): Promise<PlannedAgentTurnResult> {
  const entry = plan.sopName ? resolveSopByName(plan.sopName) : undefined;

  if (!entry) {
    // Unknown SOP name — degrade to a normal answer rather than failing.
    return fulfilChat(input, dependencies);
  }

  if (!input.account) {
    throw new AgentRouterError(
      "尚无模拟盘账户，无法执行该流程；请先初始化（例如：构建一个模拟盘账户）。",
    );
  }

  const sop = buildCerebellumAlarmSopByType(entry.alarmType);
  const ask = await runAskOnce(
    {
      question: buildSopQuestion(entry, sop),
      account: input.account,
      positions: input.positions ?? [],
      prices: input.prices,
      technicals: input.technicals,
      indices: input.indices,
      webSearch: input.webSearch,
      history: input.history,
      now: input.now,
      metadata: { source: "agent-planner-sop", sopName: entry.name },
    },
    { brainProvider: dependencies.brainProvider },
  );

  return {
    intent: "run_sop",
    reply: `【${entry.title}】\n${ask.answer}`,
    requiresConfirmation: false,
    ask,
    sopName: entry.name,
  };
}

function buildSopQuestion(entry: SopCatalogEntry, sop: CerebellumAlarmSop): string {
  return [
    `请执行【${entry.title}】这个固定流程（SOP）。`,
    renderCerebellumAlarmSop(sop),
    `目标：${sop.objective}`,
    "安全边界：",
    ...sop.forbiddenActions.map((action) => `- ${action}`),
    "请基于提供的账户、行情、技术指标和（若有）联网检索上下文，用简体中文产出该 SOP 要求的结论。",
    "直接给出明确结论与操作建议（模拟盘账户）。",
  ].join("\n");
}

interface ResearchTarget {
  symbol: string;
  market: "SSE" | "SZSE";
  name?: string;
}

function resolveResearchTarget(
  plan: TurnPlan,
  input: FulfilTurnPlanInput,
): ResearchTarget | undefined {
  const positions = input.positions ?? [];

  if (plan.symbol) {
    const held = positions.find((position) => position.symbol === plan.symbol);
    return { symbol: plan.symbol, market: held?.market ?? deriveMarket(plan.symbol), name: held?.name };
  }

  if (positions.length === 0) {
    return undefined;
  }

  // No named stock: analyze the largest holding (by cost basis) and note the rest.
  const largest = [...positions].sort(
    (a, b) => b.costPrice * b.quantity - a.costPrice * a.quantity,
  )[0];

  return { symbol: largest.symbol, market: largest.market, name: largest.name };
}

function deriveMarket(symbol: string): "SSE" | "SZSE" {
  return symbol.startsWith("6") ? "SSE" : "SZSE";
}

function formatResearchReply(report: ResearchReport, target: ResearchTarget): string {
  const head = `【深度研判 · ${target.name ? `${target.name} ` : ""}${target.symbol}】多智能体分析`;
  const verdict = `结论：${conclusionZh(report.conclusion)}｜置信度 ${Math.round(report.confidence * 100)}%`;

  const findingLine = (category: string, label: string): string | undefined => {
    const finding = report.findings.find((item) => item.category === category);
    return finding ? `· ${label}：${clipText(finding.statement, 220)}` : undefined;
  };

  const bull = report.bullBearViews.find((view) => view.side === "bull");
  const bear = report.bullBearViews.find((view) => view.side === "bear");
  const risk = report.riskFactors[0];
  const draft = report.tradeIntentDrafts[0];

  const lines: Array<string | undefined> = [
    head,
    verdict,
    "",
    clipText(report.summary, 700),
    "",
    findingLine("market", "行情"),
    findingLine("fundamental", "基本面"),
    findingLine("news", "消息面"),
    bull ? `· 多方：${clipText(bull.thesis, 160)}` : undefined,
    bear ? `· 空方：${clipText(bear.thesis, 160)}` : undefined,
    risk ? `· 风险：${clipText(risk.description, 200)}` : undefined,
    draft ? `建议：${sideZh(draft.side)}${draft.limitPrice ? `（目标价 ${draft.limitPrice}）` : ""}` : undefined,
    report.degraded ? "⚠️ 本次深度分析降级（外部引擎失败/超时）。" : undefined,
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function conclusionZh(conclusion: ResearchReport["conclusion"]): string {
  if (conclusion === "bullish") {
    return "偏多";
  }
  if (conclusion === "bearish") {
    return "偏空";
  }
  if (conclusion === "mixed") {
    return "分歧";
  }
  return "中性";
}

function sideZh(side: string): string {
  if (side === "BUY") {
    return "买入";
  }
  if (side === "SELL") {
    return "卖出";
  }
  if (side === "HOLD") {
    return "持有";
  }
  return "观望";
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function normalizePlan(plan: TurnPlan): TurnPlan {
  if (plan.intent === "reset_paper" || plan.intent === "seed_paper") {
    // The confirmation gate is deterministic; never trust the model to waive it.
    return { ...plan, requiresConfirmation: true };
  }

  if (plan.intent === "paper_ops") {
    return { ...plan, requiresConfirmation: true };
  }

  if (plan.intent === "run_sop") {
    const entry = plan.sopName ? resolveSopByName(plan.sopName) : undefined;

    if (!entry) {
      return { intent: "chat", requiresConfirmation: false };
    }

    return { ...plan, sopName: entry.name, requiresConfirmation: false };
  }

  return plan;
}

function fallbackPlan(message: string, now?: string): TurnPlan {
  // Greetings/chitchat must not fall into the analysis path when the model is down.
  if (looksLikeSmalltalk(message)) {
    return { intent: "smalltalk", requiresConfirmation: false };
  }

  const classification = classifyAgentIntent(message, now);

  switch (classification.intent) {
    case "capabilities":
      return { intent: "capabilities", requiresConfirmation: false };
    case "reset_paper":
      return { intent: "reset_paper", requiresConfirmation: true };
    case "seed_paper":
      return {
        intent: "seed_paper",
        initialCash: classification.initialCash,
        requiresConfirmation: true,
      };
    case "paper_ops":
      return {
        intent: "paper_ops",
        requiresConfirmation: true,
        ...(classification.paperOps ?? detectPaperOpsCommand(message, now) ?? {}),
      };
    case "ask":
      return { intent: "chat", requiresConfirmation: false };
  }
}

function resolvePaperOpsCommand(plan: TurnPlan, input: FulfilTurnPlanInput): PaperOpsCommand {
  const detected = detectPaperOpsCommand(input.message, input.now);

  if (detected) {
    return detected;
  }

  return {
    replayDate: plan.replayDate,
    simulateDate: plan.simulateDate,
    archiveDate: plan.archiveDate,
  };
}

function hasPaperOpsCommand(command: PaperOpsCommand): boolean {
  return Boolean(command.replayDate || command.simulateDate || command.archiveDate);
}

/** Tiny deterministic greeting net — only used when the model planner is unavailable. */
function looksLikeSmalltalk(message: string): boolean {
  const text = message.trim();

  if (text.length > 12) {
    return false;
  }

  return /^(你好|您好|哈喽|哈啰|hello|hi|hey|嗨|在吗|在不在|在么|早|早安|早上好|中午好|下午好|晚上好|晚安|你是谁|是谁|谢谢|多谢|感谢|辛苦了|ok|good|👍|🙏|😄|[?？]+)$/i.test(
    text,
  );
}
