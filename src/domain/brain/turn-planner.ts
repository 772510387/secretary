import { z } from "zod";
import { beijingDateLabel } from "../shared/index.js";
import { brainInputSchema, type BrainInput, type BrainOutput } from "./schemas.js";

/**
 * Model-driven turn routing.
 *
 * Instead of a regex classifier, the planner asks the brain to read one user
 * message and return a structured route: which intent, and (for SOP requests)
 * which SOP by name. The model decides by meaning; the backend then gates every
 * consequence deterministically (read-only context, manual-confirm for state
 * changes, no tool execution). The planner NEVER executes anything — it only
 * picks a route. Parsing is defensive: a malformed/empty structured output
 * yields `null` so the caller can fall back to the deterministic classifier.
 */
export const turnPlanIntentSchema = z.enum([
  "smalltalk",
  "chat",
  "run_sop",
  "deep_research",
  "pick_stocks",
  "capabilities",
  "reset_paper",
  "seed_paper",
  "paper_ops",
]);

export type TurnPlanIntent = z.infer<typeof turnPlanIntentSchema>;

export const turnPlanSchema = z
  .object({
    intent: turnPlanIntentSchema,
    /** Present when intent is run_sop: the catalog `name` the model selected. */
    sopName: z.string().trim().min(1).max(80).optional(),
    /** For deep_research: the named 6-digit A-share code, if the user gave one. */
    symbol: z.string().trim().regex(/^\d{6}$/).optional(),
    /** Present when intent is seed_paper and the user named an amount. */
    initialCash: z.number().finite().positive().max(100_000_000).optional(),
    /** For paper_ops: explicit YYYY-MM-DD operation dates resolved by backend or model. */
    replayDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    simulateDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    archiveDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** For smalltalk: the ready-to-send conversational reply (avoids a 2nd model call). */
    reply: z.string().trim().min(1).max(2000).optional(),
    /** True for state-changing intents that must be confirmed before executing. */
    requiresConfirmation: z.boolean().default(false),
    confirmationReason: z.string().trim().min(1).max(500).optional(),
    /** The model's short rationale for the route (kept for audit/debug only). */
    routeReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type TurnPlan = z.infer<typeof turnPlanSchema>;

export interface BuildTurnPlannerBrainInput {
  message: string;
  sopCatalog: ReadonlyArray<{ name: string; title: string; description: string }>;
  requestId?: string;
  now?: string;
  /** Whether a paper account exists (chat/SOP need one; routing should know). */
  hasAccount?: boolean;
  /** Compact recent conversation, so routing can resolve "它/那只/再说详细点". */
  history?: string;
  /** Self-correction note: what was wrong with the previous attempt's structured output. */
  correction?: string;
}

/** Intents whose fulfilment needs the (networked) account + market context. */
export function turnPlanNeedsContext(intent: TurnPlanIntent): boolean {
  return (
    intent === "chat" ||
    intent === "run_sop" ||
    intent === "deep_research" ||
    intent === "pick_stocks"
  );
}

/**
 * Builds the BrainInput for the routing call. The output-shape instruction lives
 * in the prompt (providers only forward prompt/context to the model, not the
 * structured-output Zod schema), and the model is told to put the route in the
 * `structured` field of its BrainOutput.
 */
export function buildTurnPlannerBrainInput(input: BuildTurnPlannerBrainInput): BrainInput {
  const message = input.message.trim();
  const createdAt = input.now ?? new Date().toISOString();
  const requestId = (input.requestId ?? `turn-plan-${Date.parse(createdAt)}`).slice(0, 128);

  const prompt = [
    "你是 Secretary 的【路由器】。只读这一条用户消息，判断它想做什么，输出一个路由结果。",
    "你不执行任何操作、不下单、不写账户、不改规则——你只决定走哪条路。",
    input.correction
      ? `【纠正】你上一次的输出无法被解析为合法路由（${input.correction}）。这次请严格只输出一个 JSON 对象放进 structured 字段，intent 必须是下列枚举之一，不要输出多余文字或解释。`
      : "",
    `当前日期：${beijingDateLabel(createdAt)}，时区 Asia/Shanghai。凡涉及“今天/昨天/本周一/上周五/最近”等相对时间，一律以此为基准换算，绝不要凭记忆臆测日期或年份。`,
    "",
    "可选 intent：",
    "- smalltalk：打招呼、寒暄、闲聊、问你是谁/在不在、表达情绪、道谢等，不需要看行情或持仓数据。自然回应即可。",
    "- chat：需要看数据的问答——行情、大盘、个股、持仓、仓位、风险、盈亏、操作建议、趋势研判等。",
    "- run_sop：用户想要某个固定流程（复盘、盘前计划、风险扫描等），从下面的 SOP 清单里按含义选一个，并在 sopName 里填它的 name。",
    "- deep_research：用户想要对股票做深度/完整研判、是否买卖、下周/未来操作策略、要不要加减仓等需要认真分析的问题。这会调度多智能体团队（行情/基本面/消息面 + 多空辩论 + 风控），比 chat 重得多。若用户点名了某只股票，把它的 6 位代码填进 symbol；没点名就留空（默认分析持仓）。",
    "- pick_stocks：用户想【选股】——从全市场100高关注池里挑潜力股、或问\"现在买什么/选几支/推荐潜力股/帮我选股/潜力股池深度分析\"。这会跑确定性漏斗选股(模型只在已筛好的100池里点名候选)，并生成一篮子潜力股深度分析；只读、不下单、不写账户。它和 deep_research 的区别：deep_research 是【深挖某一只】的完整研判；pick_stocks 是【从池子里挑一篮子】的选股推荐/潜力股池报告。和 chat 的区别：chat 是问答/点评，pick_stocks 是明确要候选名单或潜力股池报告。",
    "- capabilities：用户在问“有什么能力 / 怎么用 / 支持什么”。",
    "- reset_paper：用户想清空 / 重置模拟盘账户数据。requiresConfirmation 必须为 true。",
    "- seed_paper：用户想新建 / 构建模拟盘账户；若提到金额，填 initialCash（单位：元）。requiresConfirmation 必须为 true。",
    "- paper_ops：用户想执行模拟运维，例如“模拟昨天的操作”“重演昨天操作/更新数据库/再模拟今天”，或口语化的“把本周一的流程走一遍/跑一遍周一/过一遍那天的节点（有操作就落库）”。这是会按时点遮掩补跑节点、写模拟盘快照/计划/提案/纸面成交的状态变更，requiresConfirmation 必须为 true。若能确定日期，填 replayDate/simulateDate/archiveDate（YYYY-MM-DD）。",
    "",
    "可选 SOP 清单（name → 用途）：",
    ...input.sopCatalog.map((sop) => `- ${sop.name}（${sop.title}）：${sop.description}`),
    "",
    "判断原则：",
    "- 只有用户明确表达“清空/重置”或“新建/构建账户”时才用 reset_paper / seed_paper，且 requiresConfirmation=true。",
    "- 用户明确要求“模拟/重演/补跑昨天或某日操作”，或“把某日的流程走一遍/跑一遍/过一遍（尤其带‘落库/落盘/写库/数据库’）”时用 paper_ops，并把那天解析进 replayDate；复合说法如“重演昨天、更新数据库、再模拟今天”也用 paper_ops，且 requiresConfirmation=true。只是问“昨天怎么操作/昨天复盘”（没有要你去跑/落库）时不要用 paper_ops。",
    "- 用户想要某个流程化的复盘/计划/扫描时用 run_sop 并选最贴近的 sopName；拿不准就用 chat。",
    "- 需要‘深度分析/完整研判/该不该买卖/下周或未来怎么操作/要不要加减仓’这种要认真分析的问题用 deep_research；只是随口看一眼盘面、快速点评用 chat。",
    "- 用户明确要‘选股/挑几支/推荐潜力股/潜力股池深度分析/现在买什么/从池子里选’这种要一份候选名单或一篮子报告的，用 pick_stocks（只读漏斗选股，不下单不写账户）；问‘为什么看好某只/帮我深挖某只’用 deep_research；只是闲聊点评用 chat。",
    "- 纯打招呼/寒暄/闲聊（如“你好”“在吗”“你是谁”）用 smalltalk，不要当成看盘问题。",
    "- 涉及行情/持仓/个股/操作的才用 chat；其余拿不准时优先 smalltalk。",
    "- smalltalk 时，在 reply 字段直接写好要发给用户的回复：像真人一样自然、简短（1-2 句），可顺带提示能做什么（例如“想看盘就说‘现在盘面怎么样’，复盘就说‘来个收盘复盘’”）。reply 必须是直接对用户说的话，不要写成对你自己的指令或第三人称说明。",
    input.hasAccount === false
      ? "- 当前还没有模拟盘账户；如果是账户类问答也照常返回 chat，由后端提示先建账户。"
      : "",
    "",
    "把路由结果放进输出 JSON 的 structured 字段，结构如下（只填用得到的键）：",
    '{"intent":"smalltalk|chat|run_sop|deep_research|pick_stocks|capabilities|reset_paper|seed_paper|paper_ops","sopName":"<run_sop 时填>","symbol":"<deep_research 且点名个股时填 6 位代码>","initialCash":<seed_paper 且有金额时填数字>,"replayDate":"<paper_ops 可选 YYYY-MM-DD>","simulateDate":"<paper_ops 可选 YYYY-MM-DD>","archiveDate":"<paper_ops 可选 YYYY-MM-DD>","reply":"<smalltalk 时：直接发给用户的回复>","requiresConfirmation":true|false,"confirmationReason":"<需确认时一句话>","routeReason":"<一句话说明为什么这样路由>"}',
    "summary 字段填一句话中文说明你的判断即可。",
    "",
    input.history && input.history.trim() ? `【最近对话，供理解指代】\n${input.history.trim()}` : "",
    `用户消息：${message}`,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return brainInputSchema.parse({
    requestId,
    taskType: "user_query",
    prompt,
    context: {
      router: true,
      hasAccount: input.hasAccount ?? null,
      sopNames: input.sopCatalog.map((sop) => sop.name),
    },
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      toolPermissions: [],
    },
    createdAt,
  });
}

/** Defensively parse a brain output into a TurnPlan; returns null if it doesn't fit. */
export function parseTurnPlan(output: BrainOutput): TurnPlan | null {
  const result = turnPlanSchema.safeParse(output.structured);
  return result.success ? result.data : null;
}
