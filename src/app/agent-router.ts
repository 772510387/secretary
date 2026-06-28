import type { BrainProvider } from "../domain/brain/index.js";
import type { Account, Position } from "../domain/portfolio/index.js";
import {
  runAskOnce,
  type AskIndex,
  type AskPortfolioResult,
  type AskTechnical,
  type AskWebSearchContext,
} from "./ask-portfolio.js";
import {
  detectPaperOpsCommand,
  formatPaperOpsCommand,
  type PaperOpsCommand,
} from "./paper-ops-intent.js";

export type AgentIntent = "capabilities" | "reset_paper" | "seed_paper" | "paper_ops" | "ask";

export interface AgentClassification {
  intent: AgentIntent;
  initialCash?: number;
  paperOps?: PaperOpsCommand;
}

export type AgentAction =
  | { type: "reset_paper" }
  | { type: "seed_paper"; initialCash?: number }
  | ({ type: "paper_ops" } & PaperOpsCommand);

export interface AgentTurnInput {
  message: string;
  /** True once the user has explicitly confirmed a destructive/state-changing action. */
  confirmed?: boolean;
  account?: Account;
  positions?: Position[];
  prices?: Record<string, number>;
  technicals?: AskTechnical[];
  indices?: AskIndex[];
  webSearch?: AskWebSearchContext;
  now?: string;
}

export interface AgentTurnResult {
  intent: AgentIntent;
  reply: string;
  requiresConfirmation: boolean;
  action?: AgentAction;
  ask?: AskPortfolioResult;
}

export interface AgentTurnDependencies {
  brainProvider: BrainProvider;
}

export const CAPABILITIES_REPLY = [
  "Secretary 目前能力与流程（模拟盘账本）：",
  "",
  "• 问库/看盘：读真实模拟盘 DB + 实时行情，交给模型点评（agent 杂项问答 / npm run ask）。",
  "• 联网检索：后端 Tavily 搜索结果喂给模型作答（npm run ask -- --web，模型本身不联网执行工具）。",
  "• 下模拟单：RiskEngine（单股40%/止损）+ PaperBroker（主板/100股/现金/T+1）写库（npm run trade -- buy/sell）。",
  "• 自选股池：维护今日/长期/潜力三类池（npm run watchlist -- add/list）。",
  "• 自动盯市：常驻 daemon 盯持仓+高优先级自选股+大盘指数，异动推企业微信（npm run sentinel:dev -- --live）。",
  "• 复盘/SOP：直接说『做个盘前计划 / 来个收盘复盘 / 帮我深度复盘』即可触发对应固定流程。",
  "• 策略知识库：可查询命名策略、strategy_id 决策引用、派生胜率、案例和增长机制（飞书里直接问“策略库现在怎么样”）。",
  "• 模拟运维：『重演昨天操作、更新数据库、再模拟今天』会走确认门禁后补跑 paper-only 节点和盘后快照。",
  "• 深度研判：说『深度分析 X / 该不该买卖 / 下周怎么操作』，调度 TradingAgents-CN 多智能体团队（行情/基本面/消息面 + 多空辩论 + 风控）出完整研判，约数分钟（需在 .env 开启）。",
  "• 指令大脑：自然语言由模型判断意图→问答/跑 SOP/清库/建账户（本入口，非关键词规则）。危险操作需确认。",
  "",
  "说明：全程模拟盘账本（无真钱），模型可在模拟盘自主下单并写库。",
  "所有真实外呼都有显式开关（ASK_NETWORK / FEISHU_NOTIFY / SEARCH_PROVIDER）。",
].join("\n");

/** Deterministic intent classification — destructive ops must never depend on a fuzzy model parse. */
export function classifyAgentIntent(message: string, now?: string | Date): AgentClassification {
  const text = message.trim();

  if (/能力|功能|流程|怎么用|帮助|help|支持(什么|哪些)|有(什么|哪些)(功能|能力|命令|指令)|命令列表|指令列表/i.test(text)) {
    return { intent: "capabilities" };
  }

  const paperOps = detectPaperOpsCommand(text, now);

  if (paperOps) {
    return { intent: "paper_ops", paperOps };
  }

  const hasAccountContext = /模拟盘|数据库|账户|账号|持仓|仓位|数据|盘|股票|资产/.test(text);

  if (
    hasAccountContext &&
    /清除|清空|清掉|清理|清零|归零|重置|重来|重新开始|从头来|从头开始|恢复初始|恢复到初始|删库|抹掉|reset/i.test(
      text,
    )
  ) {
    return { intent: "reset_paper" };
  }

  if (hasAccountContext && /构建|初始化|创建|新建|搭建|重建|生成.*(账户|账号|盘|数据)|建(一个|个)?.*(账户|账号|盘)|seed/i.test(text)) {
    return { intent: "seed_paper", initialCash: extractCash(text) };
  }

  return { intent: "ask" };
}

/**
 * Natural-language command router: maps one user message to a backend operation
 * or a model-backed answer, and returns a reply.
 *
 * Read-only/Q&A intents go straight through; state-changing intents (reset/seed
 * the paper DB) require explicit confirmation and are returned as an `action`
 * for the caller to execute — the router never performs side effects itself.
 * It never connects to a real broker and the model never executes tools.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  dependencies: AgentTurnDependencies,
): Promise<AgentTurnResult> {
  const message = input.message.trim();

  if (!message) {
    throw new AgentRouterError("message must not be empty");
  }

  const classification = classifyAgentIntent(message, input.now);

  if (classification.intent === "capabilities") {
    return { intent: "capabilities", reply: CAPABILITIES_REPLY, requiresConfirmation: false };
  }

  if (classification.intent === "reset_paper") {
    if (!input.confirmed) {
      return {
        intent: "reset_paper",
        reply: "⚠️ 这会清空模拟盘的账户、持仓和成交记录，重置为初始状态。确认请加 --yes 重发。",
        requiresConfirmation: true,
      };
    }

    return {
      intent: "reset_paper",
      reply: "✅ 已清空模拟盘并重置为初始状态（模拟盘数据，未接真实券商）。",
      requiresConfirmation: false,
      action: { type: "reset_paper" },
    };
  }

  if (classification.intent === "seed_paper") {
    const cashText = classification.initialCash ? `，初始资金 ${classification.initialCash} 元` : "";

    if (!input.confirmed) {
      return {
        intent: "seed_paper",
        reply: `⚠️ 将（重新）构建模拟盘账户${cashText}（会清空现有账本）。确认请加 --yes 重发。`,
        requiresConfirmation: true,
      };
    }

    return {
      intent: "seed_paper",
      reply: `✅ 已构建模拟盘账户${cashText}。`,
      requiresConfirmation: false,
      action: { type: "seed_paper", initialCash: classification.initialCash },
    };
  }

  if (classification.intent === "paper_ops") {
    const detail = formatPaperOpsCommand(classification.paperOps ?? {});

    if (!input.confirmed) {
      return {
        intent: "paper_ops",
        reply: `⚠️ 将执行模拟运维：${detail}。会写入模拟盘计划/提案/纸面成交或盘后快照。确认请加 --yes 重发。`,
        requiresConfirmation: true,
      };
    }

    return {
      intent: "paper_ops",
      reply: `✅ 已确认执行模拟运维：${detail}（模拟盘数据，未接真实券商）。`,
      requiresConfirmation: false,
      action: { type: "paper_ops", ...(classification.paperOps ?? {}) },
    };
  }

  // Default: a general question answered by the model over the live DB context.
  if (!input.account) {
    throw new AgentRouterError(
      "尚无模拟盘账户，无法回答账户类问题；请先初始化（例如：构建一个模拟盘账户）。",
    );
  }

  const ask = await runAskOnce(
    {
      question: message,
      account: input.account,
      positions: input.positions ?? [],
      prices: input.prices,
      technicals: input.technicals,
      indices: input.indices,
      webSearch: input.webSearch,
      now: input.now,
      metadata: { source: "agent-router" },
    },
    { brainProvider: dependencies.brainProvider },
  );

  return { intent: "ask", reply: ask.answer, requiresConfirmation: false, ask };
}

function extractCash(text: string): number | undefined {
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万/);

  if (wan) {
    return Math.round(Number(wan[1]) * 10_000);
  }

  const yuan = text.match(/(\d{3,})\s*(?:元|块|rmb|cny)?/i);

  if (yuan) {
    const value = Number(yuan[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }

  return undefined;
}

export class AgentRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRouterError";
  }
}

/**
 * Maps a turn-handling error to a user-facing reply.
 *
 * AgentRouterError messages are already zh-CN, user-actionable guidance (e.g.
 * "请先初始化模拟盘账户") and must be shown verbatim — collapsing them into a
 * generic "请稍后再试" sends the user to a dead-end. Only genuinely unexpected
 * errors get the generic fallback (the real error is still logged by the caller).
 */
export function describeTurnError(error: unknown): string {
  if (error instanceof AgentRouterError) {
    return error.message;
  }

  if (error instanceof Error && /timed out|timeout|超时/i.test(error.message)) {
    return "这次分析超时了（请求的内容可能太多）。可以拆小一点再问，或稍后再试。";
  }

  return "处理出错了，请稍后再试。";
}
