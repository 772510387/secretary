import {
  runAgentToolLoop,
  type AgentLoopEvent,
  type AgentLoopStoppedReason,
  type AgentMessage,
  type AgentToolEffect,
  type BrainStreamProgress,
  type ToolCallingProvider,
} from "../domain/brain/index.js";
import { beijingDateLabel } from "../domain/shared/index.js";
import {
  NOTIFICATION_SUMMARY_MAX_LENGTH,
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type { PaperAgentTools } from "./brain-agent-tools.js";

/**
 * Runs ONE agentic brain turn over the paper account: the model reads what it needs
 * (eye tools) and decides + places paper trades (hand tools) in a bounded loop, then
 * returns its final answer plus the operations it actually executed.
 *
 * Deterministic by construction: the loop, the tool execution, and the sizing/fills
 * are all code; only the trade decisions are the model's. The caller turns
 * `operations` into ONE "操作+逻辑" notification (buildBrainOperationNotification).
 */
export interface RunBrainAgentInput {
  question: string;
  provider: ToolCallingProvider;
  tools: PaperAgentTools;
  /** Overrides the default system prompt entirely. */
  systemPrompt?: string;
  /** Compact recent conversation for referent resolution ("它/那只/再买点"). */
  history?: string;
  now?: string;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onProgress?: (progress: BrainStreamProgress) => void;
  maxIterations?: number;
  /** B1: cerebellum steering drained before each model step (e.g. a red-line event). */
  drainSteering?: () => AgentMessage[] | Promise<AgentMessage[]>;
  /** B2: observe each loop event (the session store subscribes here to persist). */
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface RunBrainAgentResult {
  answer: string;
  /** Every write-tool effect (fills, blocks, skips), in order. */
  effects: AgentToolEffect[];
  /** Only the effects that actually changed the simulated account (real fills). */
  operations: AgentToolEffect[];
  iterations: number;
  stoppedReason: AgentLoopStoppedReason;
  messages: AgentMessage[];
}

export async function runBrainAgentTurn(input: RunBrainAgentInput): Promise<RunBrainAgentResult> {
  const question = input.question.trim();
  if (question === "") {
    throw new BrainAgentError("question must not be empty");
  }

  const now = normalizeNow(input.now);
  const systemPrompt = input.systemPrompt ?? buildDefaultSystemPrompt(now);
  const messages: AgentMessage[] = [{ role: "system", content: systemPrompt }];
  if (input.history && input.history.trim() !== "") {
    messages.push({
      role: "user",
      content: `【最近对话，仅供理解指代，不要照抄】\n${input.history.trim()}`,
    });
  }
  messages.push({ role: "user", content: question });

  const result = await runAgentToolLoop({
    provider: input.provider,
    messages,
    tools: input.tools.specs,
    execute: input.tools.execute,
    maxIterations: input.maxIterations,
    signal: input.signal,
    idleTimeoutMs: input.idleTimeoutMs,
    onProgress: input.onProgress,
    onEvent: input.onEvent,
    drainSteering: input.drainSteering,
  });

  return {
    answer: result.answer,
    effects: result.effects,
    operations: result.effects.filter((effect) => effect.mutated),
    iterations: result.iterations,
    stoppedReason: result.stoppedReason,
    messages: result.messages,
  };
}

export function buildDefaultSystemPrompt(now: string): string {
  return [
    "你是 Secretary（小蜜）的大脑，正在操作一个【模拟盘】A 股账户（数据库模拟，未接真实券商）。",
    `当前日期：${beijingDateLabel(now)}，时区 Asia/Shanghai。涉及相对时间一律以此为准换算，绝不凭记忆臆测日期或年份。`,
    "",
    "你可以调用工具：",
    "- get_portfolio：看账户与持仓；get_quote / get_technicals：看个股行情与技术面。决策前先用读工具把数据看清楚，不要凭空臆测价格或持仓。",
    "- get_market_overview / query_watchlist / get_auction_board（若可用）：看大盘广度、板块/题材、观察池、封单和一字板。回答9:15竞价、封单、题材、观察池追问时优先用这些只读工具。",
    "- get_strategy_knowledge（若可用）：查看命名策略、strategy_id 引用、派生胜率、案例库和增长机制。回答策略库/战略/历史胜率/某条策略是否有效时先调用。",
    "- get_operation_review（若可用）：查看某交易日成交时间线、订单、原始提案/理由、当日计划、快照、报告和审计线索。回答“今天复盘/为什么买卖/卖了多少/早上是否卖出/这条价格线怎么定/时间戳是不是北京时间”等操作复盘追问时先调用。",
    "- get_feedback_audit（若可用）：用户质疑“你确定看了吗/为什么只操作几支/是不是漏看/上周复盘/问题原因”时先调用，拿观察池覆盖、计划、提案、成交和报告证据后再回答。",
    "- paper_buy / paper_sell：在模拟盘直接下单，会立即按规则成交并写库。因为是模拟盘，你可以自主大胆决策买卖，但每一笔都必须在 reason 里把买卖逻辑讲清楚。",
    "- run_paper_ops（若可用）：用户要“重演/重跑/走一遍某个历史交易日的流程、补跑某日、或把账户落库归档”时调用；它会按时点遮掩未来数据重放并写库（replayDate/simulateDate/archiveDate，至少给一个）。",
    "",
    "原则：",
    "- 先看后做：先用读工具确认现金、持仓、可卖数量、最新价，再决定是否下单。",
    "- 下单失败（被风控拦截/现金不足/无可卖数量）时，读工具看清原因后再调整，不要硬重试同一笔。",
    "- 所有数字以工具返回为准，缺失就如实说“数据缺失”，绝不编造。",
    "- 用户纠正操作事实（例如“早上卖了200股”）时，先用 get_operation_review 核对成交和时间戳；若工具证据支持用户，立即更正旧说法。",
    "- 对问责/反馈类问题要先讲清证据：哪些日期看过100池，哪些没有证据；该承认遗漏就明确承认，并给出补救动作。",
    "- 全部完成后，用简体中文给出最终结论：你做了哪些操作、为什么这么做、当前账户状态与下一步建议。",
  ].join("\n");
}

export interface BuildBrainOperationNotificationInput {
  operations: AgentToolEffect[];
  /** The model's final answer, used as the operation rationale block. */
  answer?: string;
  accountId?: string;
  now?: string;
  requestId?: string;
  /** Notification source id (defaults to "daily-funnel" so the push gate forwards it). */
  sourceId?: string;
}

const OPERATION_RATIONALE_MAX_LENGTH = 3000;

/**
 * Turns the executed operations into ONE external-push notification (the "把你操作的
 * 跟操作逻辑讲清楚发给我" message). Returns null when nothing actually changed, so the
 * caller stays silent on no-op turns. The metadata flags (executed / tradeExecuted /
 * autoPaper) make the push gate classify it as `executed_operation`.
 */
export function buildBrainOperationNotification(
  input: BuildBrainOperationNotificationInput,
): NotificationEvent | null {
  if (input.operations.length === 0) {
    return null;
  }

  const occurredAt = normalizeNow(input.now);
  const eventId = (input.requestId ?? `brain-op-${Date.parse(occurredAt)}`).slice(0, 128);
  const lines = input.operations.map((operation) => `• ${operation.summary}`);
  const answerBlock =
    input.answer && input.answer.trim() !== ""
      ? `\n\n说明：${clip(input.answer, OPERATION_RATIONALE_MAX_LENGTH)}`
      : "";
  const summary = clip(
    `【模拟盘操作】已执行 ${input.operations.length} 笔：\n${lines.join("\n")}${answerBlock}`,
    NOTIFICATION_SUMMARY_MAX_LENGTH,
  );

  return notificationEventSchema.parse({
    eventId,
    occurredAt,
    severity: "info",
    source: { type: "brain", id: input.sourceId ?? "daily-funnel" },
    target: input.accountId
      ? { type: "account", id: input.accountId }
      : { type: "portfolio" },
    summary,
    recommendedAction: "已在模拟盘按以上逻辑执行；如需调整请直接回复。",
    correlationId: eventId,
    channels: ["console", "feishu"],
    metadata: {
      executed: true,
      tradeExecuted: true,
      autoPaper: true,
      operationCount: input.operations.length,
      operations: input.operations.map((operation) => operation.data ?? operation.summary),
    },
  });
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function normalizeNow(now: string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }
  const parsed = new Date(now);
  if (Number.isNaN(parsed.getTime())) {
    throw new BrainAgentError(`Invalid timestamp: ${now}`);
  }
  return parsed.toISOString();
}

export class BrainAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainAgentError";
  }
}
