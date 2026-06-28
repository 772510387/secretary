import {
  cerebellumAlarmRuleSchema,
  cerebellumAlarmSopSchema,
  type CerebellumAlarmRule,
  type CerebellumAlarmSop,
  type CerebellumAlarmType,
  type CerebellumContextSourceCategory,
} from "./schemas.js";
import type { JsonValue } from "../shared/index.js";

interface SopRequiredInputDraft {
  inputId: string;
  category: CerebellumContextSourceCategory;
  relativePath: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

interface SopTemplateDraft {
  wakeRule?: string;
  objective: string;
  operationInstructions?: readonly string[];
  requiredInputs: readonly SopRequiredInputDraft[];
  allowedActions: readonly string[];
  forbiddenActions: readonly string[];
  safetyConstraints?: readonly string[];
}

const rulesInput = input({
  inputId: "rules",
  category: "rules",
  relativePath: "memory/rules/README.md",
  summary: "Deterministic policy and risk rule references.",
});

const portfolioInput = input({
  inputId: "portfolio-metadata",
  category: "portfolio",
  relativePath: "memory/portfolio",
  summary: "Latest paper portfolio metadata path if available; use only provided values.",
});

const marketInput = input({
  inputId: "market-cache",
  category: "market",
  relativePath: "data/cache/market",
  summary: "Local market snapshot and history metadata paths.",
});

const reportInput = input({
  inputId: "recent-reports",
  category: "reports",
  relativePath: "memory/reports",
  summary: "Recent report metadata and summaries.",
});

const researchInput = input({
  inputId: "recent-research",
  category: "research",
  relativePath: "memory/research",
  summary: "Recent research report metadata and summaries.",
});

const proposalInput = input({
  inputId: "pending-proposals",
  category: "proposals",
  relativePath: "memory/proposals",
  summary: "Pending manual review proposal metadata.",
});

const runtimeInput = input({
  inputId: "runtime-health",
  category: "logs",
  relativePath: "memory/logs/runtime-health.json",
  summary: "Runtime health metadata and latest error summary.",
});

const logInput = input({
  inputId: "audit-log-summaries",
  category: "logs",
  relativePath: "memory/logs",
  summary: "Audit and runtime log metadata summaries.",
});

const configInput = input({
  inputId: "non-secret-config",
  category: "config",
  relativePath: "config",
  summary: "Non-secret configuration templates and local runtime flags.",
});

const commonAllowedActions = [
  "Read only the listed paths, summaries, and metadata.",
  "Return gaps when an expected input is missing.",
  "Generate a report task, research task, notification, or manual-review proposal.",
] as const;

const commonForbiddenActions = [
  "Do not invent symbols, watchlists, positions, cash, orders, or fills.",
  "Do not read secrets, environment files, tokens, passwords, private keys, or credentials.",
  "Do not place orders, submit broker requests, write portfolio state, or enable live trading.",
  "Do not override policy, risk, memory write, proposal, or audit rules.",
] as const;

const commonSafetyConstraints = [
  "Use metadata and summaries only; do not embed full sensitive documents.",
  "Keep toolExecutionAllowed=false, brokerSubmissionAllowed=false, accountWriteAllowed=false, and liveTradingAllowed=false.",
  "If data is stale or absent, record that as an input gap instead of filling it in.",
] as const;

export const CEREBELLUM_ALARM_SOP_TEMPLATES: Record<CerebellumAlarmType, SopTemplateDraft> = {
  data_warmup: template({
    objective: "Verify local data readiness before the market preparation window.",
    requiredInputs: [configInput, marketInput, runtimeInput, rulesInput],
    allowedActions: [
      "Check whether local market and runtime metadata are present and recent.",
      "List missing or stale inputs for later provider refresh.",
    ],
    forbiddenActions: [
      "Do not fetch live market data from the network inside this SOP.",
      "Do not create market data when a cache path is empty.",
    ],
  }),
  overnight_digest: template({
    objective: "Organize overnight information summaries for pre-market review.",
    requiredInputs: [researchInput, reportInput, logInput, rulesInput],
    allowedActions: [
      "Summarize existing overnight research and report metadata.",
      "Mark unresolved topics that require later human or provider input.",
    ],
    forbiddenActions: [
      "Do not fabricate news, policy changes, sector themes, or external citations.",
    ],
  }),
  pre_market_plan: template({
    objective: "Prepare a pre-market plan from available rules, portfolio metadata, and recent memory.",
    requiredInputs: [rulesInput, portfolioInput, marketInput, researchInput, reportInput, proposalInput],
    allowedActions: [
      "Draft a planning report using only supplied context summaries.",
      "Create manual-review proposals when an action cannot be decided deterministically.",
    ],
    forbiddenActions: [
      "Do not assume holdings, available cash, or watchlist entries that are not in the supplied metadata.",
    ],
  }),
  call_auction_watch: template({
    objective: "Prepare a call auction observation checklist from existing market metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, runtimeInput],
    allowedActions: [
      "Identify which listed input paths should be inspected after auction data is available.",
      "Flag stale market metadata for later refresh.",
    ],
    forbiddenActions: [
      "Do not infer auction prices or volumes when no source provides them.",
    ],
  }),
  pre_open_confirmation: template({
    objective: "Confirm the pre-open safety checklist before continuous trading starts.",
    requiredInputs: [rulesInput, portfolioInput, proposalInput, runtimeInput],
    allowedActions: [
      "Check that pending proposals and runtime health metadata are visible.",
      "Summarize blockers that require manual review before trading assistance continues.",
    ],
    forbiddenActions: [
      "Do not approve, reject, or hand off any proposal from this SOP.",
    ],
  }),
  morning_review: template({
    objective: "Review the first morning trading segment using available market and memory metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, reportInput, logInput],
    allowedActions: [
      "Summarize observed metadata changes and unresolved risks.",
      "Create notification or research tasks when deterministic inputs show a gap or anomaly.",
    ],
    forbiddenActions: [
      "Do not claim intraday moves unless they are present in supplied market metadata.",
    ],
  }),
  midday_review: template({
    objective: "Build a midday review package from morning summaries and risk metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, reportInput, researchInput],
    allowedActions: [
      "Compare current summaries with the pre-market plan.",
      "List risk notes and missing context for the afternoon session.",
    ],
    forbiddenActions: [
      "Do not generate trades or position changes from a review note.",
    ],
  }),
  afternoon_risk_scan: template({
    objective: "Scan afternoon risk metadata and prepare non-executing alert tasks.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, proposalInput, logInput],
    allowedActions: [
      "Check supplied metadata for stale data, pending reviews, and risk indicators.",
      "Create alert or research tasks for manual follow-up.",
    ],
    forbiddenActions: [
      "Do not bypass PolicyEngine, RiskEngine, proposal review, or audit requirements.",
    ],
  }),
  late_session_plan: template({
    objective: "Prepare a late-session plan without sending broker requests.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, proposalInput, reportInput],
    allowedActions: [
      "List manual-review candidates and data gaps before close.",
      "Draft a proposal checklist for later human confirmation.",
    ],
    forbiddenActions: [
      "Do not turn a late-session note into an order or broker handoff.",
    ],
  }),
  closing_snapshot: template({
    objective: "Capture closing snapshot requirements from market, portfolio, and runtime metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, logInput],
    allowedActions: [
      "Prepare a closing snapshot task with source paths and summaries.",
      "Flag any missing closing data as a gap.",
    ],
    forbiddenActions: [
      "Do not create closing prices, executions, or valuations that are absent from sources.",
    ],
  }),
  closing_review: template({
    objective: "Prepare a closing review package from supplied market, portfolio, and report metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, reportInput, researchInput, logInput],
    allowedActions: [
      "Summarize supplied closing metadata and unresolved risk notes.",
      "Draft follow-up report, research, notification, or manual-review proposal tasks.",
    ],
    forbiddenActions: [
      "Do not create closing prices, executions, valuations, or performance values that are absent from sources.",
    ],
  }),
  post_close_review: template({
    objective: "Prepare an extended post-close review from reports, research, and audit metadata.",
    requiredInputs: [rulesInput, marketInput, portfolioInput, reportInput, researchInput, logInput],
    allowedActions: [
      "Summarize report and research metadata for the completed session.",
      "Draft follow-up research or memory proposal tasks.",
    ],
    forbiddenActions: [
      "Do not write long-term memory directly from this SOP.",
    ],
  }),
  deep_review: template({
    objective: "Prepare a deep review package for strategy reflection and risk learning.",
    requiredInputs: [rulesInput, reportInput, researchInput, proposalInput, logInput],
    allowedActions: [
      "Collect decision summaries, risk notes, and unresolved proposal metadata.",
      "Draft memory-write proposals when learning points need persistence.",
    ],
    forbiddenActions: [
      "Do not weaken hard rules or convert reflection into direct trading actions.",
    ],
  }),
  next_day_watchlist: template({
    objective: "Prepare next-day observation pool requirements from existing memory only.",
    requiredInputs: [rulesInput, researchInput, reportInput, proposalInput, marketInput],
    allowedActions: [
      "List source paths that can support a future watchlist review.",
      "Create manual-review proposals for observation candidates already present in memory.",
    ],
    forbiddenActions: [
      "Do not invent watchlist entries, priorities, prices, or reasons.",
    ],
  }),
  daily_reflection: template({
    objective: "Prepare daily reflection context from reports, research, proposals, and audit metadata.",
    requiredInputs: [rulesInput, reportInput, researchInput, proposalInput, logInput, runtimeInput],
    allowedActions: [
      "Summarize completed tasks, unresolved risks, and input gaps for the day.",
      "Draft memory-write proposals for lessons that require review.",
    ],
    forbiddenActions: [
      "Do not rewrite rules, delete audit data, or persist lessons without policy review.",
    ],
  }),
  weekly_review: template({
    objective: "Prepare weekly review context using existing report and research metadata.",
    requiredInputs: [rulesInput, reportInput, researchInput, proposalInput, logInput],
    allowedActions: [
      "Aggregate available weekly summaries and unresolved risk metadata.",
      "Draft follow-up report, research, or memory proposal tasks.",
    ],
    forbiddenActions: [
      "Do not infer missing trading days, trades, holdings, or performance values.",
    ],
  }),
  monthly_review: template({
    objective: "Prepare month-end review context from existing summaries and audit metadata.",
    requiredInputs: [rulesInput, reportInput, researchInput, proposalInput, logInput],
    allowedActions: [
      "Aggregate available monthly report and risk metadata.",
      "List open proposals and recurring data gaps for manual review.",
    ],
    forbiddenActions: [
      "Do not produce unaudited performance, cash, or position totals.",
    ],
  }),
  yearly_review: template({
    objective: "Prepare year-end review context from existing reports, research, proposals, and audit metadata.",
    requiredInputs: [rulesInput, reportInput, researchInput, proposalInput, logInput],
    allowedActions: [
      "Aggregate year-end source paths and summary metadata.",
      "Draft long-horizon reflection and follow-up proposal tasks.",
    ],
    forbiddenActions: [
      "Do not claim annual returns, trades, or holdings unless provided by audited inputs.",
    ],
  }),
  weekend_morning_brief: template({
    objective: "Prepare a weekend A-share morning brief from settled weekly facts and overnight/外盘 metadata.",
    requiredInputs: [rulesInput, reportInput, researchInput, marketInput, logInput],
    allowedActions: [
      "Summarize the past week's recorded moves and weekend/external-market headlines from supplied metadata.",
      "Draft a next-week focus list as manual-review notes only.",
    ],
    forbiddenActions: [
      "Do not invent index levels, sector moves, or news that are not in the supplied metadata.",
    ],
  }),
  weekly_knowledge_absorb: template({
    objective: "Prepare a weekend knowledge-absorption package from existing research, reports, and lessons.",
    requiredInputs: [rulesInput, researchInput, reportInput, proposalInput, logInput],
    allowedActions: [
      "Summarize existing research and lesson metadata into reusable study notes.",
      "Draft memory-write proposals for lessons that need persistence.",
    ],
    forbiddenActions: [
      "Do not fabricate study sources, citations, or performance claims.",
    ],
  }),
  weekly_live_report: template({
    objective: "Prepare a weekly paper-trading report from the week's account snapshots, fills, and summaries.",
    requiredInputs: [rulesInput, portfolioInput, reportInput, logInput],
    allowedActions: [
      "Aggregate the week's recorded fills and snapshot summaries into a paper-trading report.",
      "Flag missing days or unverifiable figures as data gaps.",
    ],
    forbiddenActions: [
      "Do not produce unaudited returns, cash, or position totals; do not place orders.",
    ],
  }),
  weekly_winrate_review: template({
    objective: "Prepare a trading-system win-rate review from scored decisions and recorded fills only.",
    requiredInputs: [rulesInput, reportInput, researchInput, logInput],
    allowedActions: [
      "Aggregate win-rate, profit-factor, and max-drawdown figures only from already-scored decision metadata.",
      "Mark insufficient-sample strategies as 待验证 instead of asserting a rate.",
    ],
    forbiddenActions: [
      "Do not compute a win-rate or drawdown from data that has not been scored and recorded.",
    ],
  }),
};

export function buildCerebellumAlarmSop(alarmInput: CerebellumAlarmRule): CerebellumAlarmSop {
  const alarm = cerebellumAlarmRuleSchema.parse(alarmInput);
  return buildCerebellumAlarmSopByType(alarm.alarmType);
}

/**
 * Builds the deterministic SOP package for an alarm type without requiring a full
 * alarm rule. Used by the text-invoked SOP path (a user asking for a SOP by name)
 * where there is no scheduled alarm context, only the chosen SOP type.
 */
export function buildCerebellumAlarmSopByType(alarmType: CerebellumAlarmType): CerebellumAlarmSop {
  const draft = CEREBELLUM_ALARM_SOP_TEMPLATES[alarmType];

  return cerebellumAlarmSopSchema.parse({
    wakeRule: sanitizeText(draft.wakeRule ?? defaultWakeRule(alarmType)),
    objective: sanitizeText(draft.objective),
    operationInstructions: (draft.operationInstructions ?? defaultOperationInstructions(alarmType)).map(sanitizeText),
    requiredInputs: draft.requiredInputs.map(sanitizeRequiredInput),
    allowedActions: uniqueStrings([...commonAllowedActions, ...draft.allowedActions]).map(sanitizeText),
    forbiddenActions: uniqueStrings([...commonForbiddenActions, ...draft.forbiddenActions]).map(sanitizeText),
    safetyConstraints: uniqueStrings([
      ...commonSafetyConstraints,
      ...(draft.safetyConstraints ?? []),
    ]).map(sanitizeText),
  });
}

export function renderCerebellumAlarmSop(sop: CerebellumAlarmSop): string {
  return [
    `唤醒规则：${sop.wakeRule}`,
    "操作指令：",
    ...sop.operationInstructions.map((instruction, index) => `${index + 1}. ${instruction}`),
  ].join("\n");
}

function defaultWakeRule(alarmType: CerebellumAlarmType): string {
  const prefix = "固定闹钟唤醒：北京时间调度器命中当前 SOP 节点。";

  switch (alarmType) {
    case "weekly_review":
      return `${prefix}本节点按周复盘规则触发，只能读取已落库的周内事实和摘要。`;
    case "monthly_review":
      return `${prefix}本节点按月末复盘规则触发，只能读取已落库的月内事实和摘要。`;
    case "yearly_review":
      return `${prefix}本节点按年末复盘规则触发，只能读取已落库的年内事实和摘要。`;
    case "daily_reflection":
      return `${prefix}本节点按每日自省规则触发，只能总结已发生和已落库的信息。`;
    default:
      return `${prefix}执行前必须使用后端提供的真实上下文，缺失数据必须明示为缺口。`;
  }
}

function defaultOperationInstructions(alarmType: CerebellumAlarmType): string[] {
  const reviewScope =
    alarmType === "weekly_review"
      ? "本周"
      : alarmType === "monthly_review"
        ? "本月"
        : alarmType === "yearly_review"
          ? "本年"
          : "当前节点";

  return [
    "读取后端提供的账户、持仓、行情、指数、自选池、报告、研究、提案和日志上下文。",
    "先核对 dataHealth 和来源时间；任何缺失、过期或降级的数据必须明确写为输入缺口。",
    `围绕${reviewScope}目标输出结论、风险、待人工复核动作和需要补充的数据。`,
    "不得编造股票、价格、指数、新闻、持仓、成交或资金；不得下单、写账户或改规则。",
  ];
}

function input(draft: SopRequiredInputDraft): SopRequiredInputDraft {
  return draft;
}

function template(draft: SopTemplateDraft): SopTemplateDraft {
  return draft;
}

function sanitizeRequiredInput(inputDraft: SopRequiredInputDraft): SopRequiredInputDraft {
  assertSafeContextPath(inputDraft.relativePath);

  return {
    inputId: safeIdentifier(inputDraft.inputId, 80),
    category: inputDraft.category,
    relativePath: sanitizeText(inputDraft.relativePath),
    summary: sanitizeText(inputDraft.summary),
    metadata: sanitizeJsonObject(inputDraft.metadata),
  };
}

function sanitizeJsonObject(inputValue: unknown): Record<string, JsonValue> {
  if (typeof inputValue !== "object" || inputValue === null || Array.isArray(inputValue)) {
    return {};
  }

  return sanitizeJsonValue(inputValue) as Record<string, JsonValue>;
}

function sanitizeJsonValue(inputValue: unknown): JsonValue {
  if (typeof inputValue === "string") {
    return sanitizeText(inputValue);
  }

  if (typeof inputValue === "number") {
    return Number.isFinite(inputValue) ? inputValue : null;
  }

  if (typeof inputValue === "boolean" || inputValue === null) {
    return inputValue;
  }

  if (Array.isArray(inputValue)) {
    return inputValue.map(sanitizeJsonValue);
  }

  if (typeof inputValue === "object" && inputValue !== null) {
    const output: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(inputValue)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeJsonValue(value);
    }

    return output;
  }

  return null;
}

function sanitizeText(inputValue: string): string {
  return inputValue
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|account)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .trim();
}

function assertSafeContextPath(relativePath: string): void {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();

  if (
    normalized.includes("/secrets/") ||
    normalized.includes("/secret/") ||
    normalized.includes(".env") ||
    normalized.includes("credential")
  ) {
    throw new CerebellumAlarmSopError("SOP required input path must not reference secrets");
  }
}

function isSensitiveKey(key: string): boolean {
  return /(secret|token|password|api_?key|private_?key|credential|account)/i.test(key);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "sop-input";
}

export class CerebellumAlarmSopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebellumAlarmSopError";
  }
}
