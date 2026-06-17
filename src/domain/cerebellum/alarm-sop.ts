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
  objective: string;
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
};

export function buildCerebellumAlarmSop(alarmInput: CerebellumAlarmRule): CerebellumAlarmSop {
  const alarm = cerebellumAlarmRuleSchema.parse(alarmInput);
  const draft = CEREBELLUM_ALARM_SOP_TEMPLATES[alarm.alarmType];

  return cerebellumAlarmSopSchema.parse({
    objective: sanitizeText(draft.objective),
    requiredInputs: draft.requiredInputs.map(sanitizeRequiredInput),
    allowedActions: uniqueStrings([...commonAllowedActions, ...draft.allowedActions]).map(sanitizeText),
    forbiddenActions: uniqueStrings([...commonForbiddenActions, ...draft.forbiddenActions]).map(sanitizeText),
    safetyConstraints: uniqueStrings([
      ...commonSafetyConstraints,
      ...(draft.safetyConstraints ?? []),
    ]).map(sanitizeText),
  });
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
