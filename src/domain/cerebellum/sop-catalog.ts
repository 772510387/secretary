import { cerebellumAlarmTypeSchema, type CerebellumAlarmType } from "./schemas.js";

/**
 * A text-invokable SOP. Each entry maps a stable, human-typed `name` to one of
 * the fixed cerebellum alarm SOP templates, plus a model-facing `description`
 * used for routing.
 *
 * The description is the only thing the planner model reads to decide whether a
 * user message wants this SOP — the same idea as an OpenClaw SKILL.md frontmatter
 * `description`. Selection is model-driven (by meaning), not regex. The SOP body
 * (objective / allowed / forbidden actions) still comes from the deterministic
 * `alarm-sop` templates, so the safety rails are unchanged.
 */
export interface SopCatalogEntry {
  /** Stable id the planner returns and a human could type, e.g. "pre-market-plan". */
  readonly name: string;
  /** The underlying deterministic SOP template this resolves to. */
  readonly alarmType: CerebellumAlarmType;
  /** Short human title (zh). */
  readonly title: string;
  /** When to use this SOP — the routing signal the planner matches against. */
  readonly description: string;
}

export const SOP_CATALOG: readonly SopCatalogEntry[] = [
  {
    name: "data-warmup",
    alarmType: "data_warmup",
    title: "数据预热",
    description: "盘前检查本地行情与运行态数据是否就绪、是否有缺口需要刷新。",
  },
  {
    name: "overnight-digest",
    alarmType: "overnight_digest",
    title: "隔夜消息整理",
    description: "汇总隔夜外盘、政策与新闻，评估对持仓的利好利空。",
  },
  {
    name: "pre-market-plan",
    alarmType: "pre_market_plan",
    title: "盘前计划",
    description: "开盘前根据规则、持仓和近期记忆，制定今日计划、点位预案和强弱基调。",
  },
  {
    name: "call-auction-watch",
    alarmType: "call_auction_watch",
    title: "集合竞价观察",
    description: "集合竞价阶段的观察清单与风向判断。",
  },
  {
    name: "pre-open-confirmation",
    alarmType: "pre_open_confirmation",
    title: "开盘前确认",
    description: "连续竞价开始前的安全检查与待办确认。",
  },
  {
    name: "morning-review",
    alarmType: "morning_review",
    title: "早盘回顾",
    description: "早盘第一段的回顾：观察量能、确认主线、检查持仓安全垫。",
  },
  {
    name: "midday-review",
    alarmType: "midday_review",
    title: "午间回顾",
    description: "午盘小结：对照盘前计划，列出风险点和下午需要关注的内容。",
  },
  {
    name: "afternoon-risk-scan",
    alarmType: "afternoon_risk_scan",
    title: "午后风险扫描",
    description: "午后的风险扫描：检查跳水风险、高位股和异常信号。",
  },
  {
    name: "late-session-plan",
    alarmType: "late_session_plan",
    title: "尾盘预案",
    description: "尾盘前的预案：列出需要人工复核的候选和数据缺口。",
  },
  {
    name: "closing-snapshot",
    alarmType: "closing_snapshot",
    title: "收盘快照",
    description: "收盘快照需求：从行情、持仓和运行态元数据准备收盘快照。",
  },
  {
    name: "closing-review",
    alarmType: "closing_review",
    title: "收盘回顾",
    description: "收盘复盘：当日盈亏、持仓变化与未决风险小结。",
  },
  {
    name: "post-close-review",
    alarmType: "post_close_review",
    title: "盘后扩展复盘",
    description: "盘后扩展复盘：基于报告、研究和审计元数据做更完整的复盘。",
  },
  {
    name: "deep-review",
    alarmType: "deep_review",
    title: "深度复盘",
    description: "深度复盘：策略反思与风险学习，沉淀经验（只生成待人工复核的提案，不改规则）。",
  },
  {
    name: "next-day-watchlist",
    alarmType: "next_day_watchlist",
    title: "次日观察池",
    description: "整理次日观察池需求，只基于现有记忆，不臆造标的。",
  },
  {
    name: "daily-reflection",
    alarmType: "daily_reflection",
    title: "每日自省",
    description: "每日自省：汇总当天完成的任务、未决风险和数据缺口。",
  },
  {
    name: "weekly-review",
    alarmType: "weekly_review",
    title: "周复盘",
    description: "周复盘：聚合本周报告与研究元数据，做一周总结。",
  },
  {
    name: "monthly-review",
    alarmType: "monthly_review",
    title: "月复盘",
    description: "月复盘：基于现有月度汇总和审计元数据做月度回顾。",
  },
  {
    name: "yearly-review",
    alarmType: "yearly_review",
    title: "年复盘",
    description: "年复盘：基于全年报告、研究、提案和审计元数据做年度回顾。",
  },
];

const SOP_BY_NAME = new Map<string, SopCatalogEntry>(SOP_CATALOG.map((entry) => [entry.name, entry]));
const SOP_BY_ALARM_TYPE = new Map<CerebellumAlarmType, SopCatalogEntry>(
  SOP_CATALOG.map((entry) => [entry.alarmType, entry]),
);

/** Resolve a planner-returned (or human-typed) SOP name to its catalog entry. */
export function resolveSopByName(name: string): SopCatalogEntry | undefined {
  return SOP_BY_NAME.get(name.trim().toLowerCase());
}

/** Resolve the catalog entry backing a given alarm SOP type. */
export function resolveSopByAlarmType(alarmType: CerebellumAlarmType): SopCatalogEntry | undefined {
  return SOP_BY_ALARM_TYPE.get(cerebellumAlarmTypeSchema.parse(alarmType));
}

/** Compact catalog (name + title + description) for the planner prompt. */
export function sopCatalogForPrompt(): Array<{ name: string; title: string; description: string }> {
  return SOP_CATALOG.map((entry) => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
  }));
}
