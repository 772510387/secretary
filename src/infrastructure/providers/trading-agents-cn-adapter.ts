import {
  researchReportSchema,
  validateResearchReport,
  validateResearchTask,
  type ResearchConclusion,
  type ResearchFindingCategory,
  type ResearchReport,
  type ResearchTask,
  type RiskFactor,
  type TradeIntentDraft,
} from "../../domain/research/index.js";
import type { JsonValue } from "../../domain/shared/index.js";
import { ResearchProviderError } from "./errors.js";

export interface TradingAgentsCnRunnerContext {
  signal: AbortSignal;
  timeoutMs: number;
}

export type TradingAgentsCnRunner = (
  task: ResearchTask,
  context: TradingAgentsCnRunnerContext,
) => Promise<unknown>;

export interface TradingAgentsCnAdapterOptions {
  runner: TradingAgentsCnRunner;
  timeoutMs?: number;
  fallbackOnError?: boolean;
  now?: () => Date;
  idGenerator?: () => string;
}

export class TradingAgentsCnAdapter {
  private readonly runner: TradingAgentsCnRunner;
  private readonly timeoutMs: number;
  private readonly fallbackOnError: boolean;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: TradingAgentsCnAdapterOptions) {
    this.runner = options.runner;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fallbackOnError = options.fallbackOnError ?? true;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new ResearchProviderError("TradingAgentsCnAdapter timeoutMs must be positive");
    }
  }

  async runResearch(taskInput: ResearchTask): Promise<ResearchReport> {
    const task = validateResearchTask(taskInput);

    try {
      const raw = await this.runWithTimeout(task);
      return adaptTradingAgentsCnOutput(task, raw, {
        generatedAt: this.isoNow(),
        idGenerator: this.idGenerator,
      });
    } catch (error) {
      if (!this.fallbackOnError) {
        throw toResearchProviderError(error);
      }

      return buildDegradedResearchReport(task, {
        generatedAt: this.isoNow(),
        idGenerator: this.idGenerator,
        error,
      });
    }
  }

  private async runWithTimeout(task: ResearchTask): Promise<unknown> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort("timeout");
        reject(new ResearchProviderError(`TradingAgents-CN research timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    try {
      return await Promise.race([
        this.runner(task, {
          signal: controller.signal,
          timeoutMs: this.timeoutMs,
        }),
        timeoutPromise,
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ResearchProviderError("TradingAgentsCnAdapter now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function adaptTradingAgentsCnOutput(
  task: ResearchTask,
  rawOutput: unknown,
  options: {
    generatedAt: string;
    idGenerator: () => string;
  },
): ResearchReport {
  const raw = asRecord(rawOutput);
  const summary = firstString(
    raw.summary,
    raw.finalReport,
    raw.final_report,
    raw.report,
    raw.analysis,
    raw.decision,
  );
  const findings = normalizeFindings(raw.findings, summary, options.idGenerator);
  const bullBearViews = [
    ...normalizeViews("bull", raw.bullish, raw.bullCase, raw.bull_case, raw.pros),
    ...normalizeViews("bear", raw.bearish, raw.bearCase, raw.bear_case, raw.cons),
  ];
  const riskFactors = normalizeRisks(raw.risks, raw.riskFactors, options.idGenerator);
  const sources = normalizeSources(raw.sources, options.idGenerator);
  const tradeIntentDrafts = normalizeTradeDrafts(
    raw.recommendations ?? raw.tradeIdeas ?? raw.trade_ideas,
    task,
    options.idGenerator,
  );

  return validateResearchReport({
    reportId: `research-${task.symbol}-${task.tradingDate}-${safeId(options.idGenerator())}`,
    taskId: task.taskId,
    provider: "trading_agents_cn",
    symbol: task.symbol,
    market: task.market,
    name: task.name,
    tradingDate: task.tradingDate,
    generatedAt: options.generatedAt,
    title: firstString(raw.title) ?? `${task.tradingDate} ${task.symbol} TradingAgents-CN Research`,
    summary: summary ?? "TradingAgents-CN returned structured research without a final summary.",
    conclusion: normalizeConclusion(raw.conclusion ?? raw.sentiment ?? raw.rating),
    confidence: normalizeConfidence(raw.confidence),
    findings,
    bullBearViews,
    riskFactors,
    sources,
    tradeIntentDrafts,
    requiresHumanReview: true,
    degraded: false,
    metadata: {
      source: "trading_agents_cn",
      liveTrading: false,
      directExecutionAllowed: false,
      ignoredExecutionFields: detectExecutionFields(raw),
      rawKeys: Object.keys(raw),
    },
  });
}

function buildDegradedResearchReport(
  task: ResearchTask,
  options: {
    generatedAt: string;
    idGenerator: () => string;
    error: unknown;
  },
): ResearchReport {
  const errorMessage = options.error instanceof Error
    ? options.error.message
    : String(options.error);

  return researchReportSchema.parse({
    reportId: `research-${task.symbol}-${task.tradingDate}-${safeId(options.idGenerator())}`,
    taskId: task.taskId,
    provider: "trading_agents_cn",
    symbol: task.symbol,
    market: task.market,
    name: task.name,
    tradingDate: task.tradingDate,
    generatedAt: options.generatedAt,
    title: `${task.tradingDate} ${task.symbol} TradingAgents-CN Research Degraded`,
    summary: `TradingAgents-CN research failed or timed out: ${errorMessage}`,
    conclusion: "neutral",
    confidence: 0,
    findings: [
      {
        findingId: `finding-${safeId(options.idGenerator())}`,
        category: "risk",
        statement: "External research adapter returned a degraded report.",
        evidence: [errorMessage],
        confidence: 1,
      },
    ],
    bullBearViews: [
      {
        side: "neutral",
        thesis: "No external research conclusion is available.",
        evidence: [errorMessage],
        confidence: 1,
      },
    ],
    riskFactors: [
      {
        riskId: `risk-${safeId(options.idGenerator())}`,
        severity: "warning",
        description: "External research failed; do not use this result for trading decisions.",
        mitigation: "Retry research or use manual review.",
      },
    ],
    sources: [
      {
        sourceId: `source-${safeId(options.idGenerator())}`,
        sourceType: "trading_agents_cn",
        title: "TradingAgents-CN adapter failure",
        observedAt: options.generatedAt,
        note: errorMessage,
      },
    ],
    tradeIntentDrafts: [],
    requiresHumanReview: true,
    degraded: true,
    metadata: {
      source: "trading_agents_cn",
      error: errorMessage,
      liveTrading: false,
      directExecutionAllowed: false,
    },
  });
}

function normalizeFindings(
  value: unknown,
  summary: string | undefined,
  idGenerator: () => string,
): Array<ResearchReport["findings"][number]> {
  const candidates = toArray(value);

  if (candidates.length === 0) {
    return [
      {
        findingId: `finding-${safeId(idGenerator())}`,
        category: "other",
        statement: summary ?? "No explicit finding was returned.",
        evidence: [],
        confidence: 0.5,
      },
    ];
  }

  return candidates.map((candidate) => {
    const record = asRecord(candidate);
    const statement = firstString(record.statement, record.text, record.summary, candidate)
      ?? "TradingAgents-CN finding";

    return {
      findingId: firstString(record.findingId, record.id) ?? `finding-${safeId(idGenerator())}`,
      category: normalizeFindingCategory(record.category),
      statement,
      evidence: toStringArray(record.evidence),
      confidence: normalizeConfidence(record.confidence),
    };
  });
}

function normalizeViews(
  side: "bull" | "bear",
  ...values: unknown[]
): Array<ResearchReport["bullBearViews"][number]> {
  return values.flatMap((value) =>
    toArray(value).map((candidate) => {
      const record = asRecord(candidate);
      const thesis = firstString(record.thesis, record.text, record.summary, candidate)
        ?? (side === "bull" ? "Bullish view" : "Bearish view");

      return {
        side,
        thesis,
        evidence: toStringArray(record.evidence),
        confidence: normalizeConfidence(record.confidence),
      };
    }),
  );
}

function normalizeRisks(
  ...values: unknown[]
): RiskFactor[] {
  const risks = values.flatMap(toArray);

  if (risks.length === 0) {
    return [];
  }

  return risks.map((candidate, index) => {
    const record = asRecord(candidate);
    return {
      riskId: firstString(record.riskId, record.id) ?? `risk-${index + 1}`,
      severity: normalizeRiskSeverity(record.severity),
      description: firstString(record.description, record.text, record.summary, candidate)
        ?? "TradingAgents-CN risk factor",
      mitigation: firstString(record.mitigation, record.action),
    };
  });
}

function normalizeSources(
  value: unknown,
  idGenerator: () => string,
): ResearchReport["sources"] {
  return toArray(value).map((candidate) => {
    const record = asRecord(candidate);
    return {
      sourceId: firstString(record.sourceId, record.id) ?? `source-${safeId(idGenerator())}`,
      sourceType: normalizeSourceType(record.sourceType ?? record.type),
      title: firstString(record.title, record.name, record.url, candidate) ?? "TradingAgents-CN source",
      url: firstString(record.url),
      observedAt: firstString(record.observedAt, record.retrievedAt),
      note: firstString(record.note, record.description),
    };
  });
}

function normalizeTradeDrafts(
  value: unknown,
  task: ResearchTask,
  idGenerator: () => string,
): TradeIntentDraft[] {
  return toArray(value).map((candidate) => {
    const record = asRecord(candidate);
    return {
      draftId: firstString(record.draftId, record.id) ?? `draft-${safeId(idGenerator())}`,
      symbol: firstString(record.symbol) ?? task.symbol,
      market: record.market === "SSE" || record.market === "SZSE" ? record.market : task.market,
      name: firstString(record.name) ?? task.name,
      side: normalizeDraftSide(record.side ?? record.action ?? record.recommendation),
      quantity: positiveIntegerOrUndefined(record.quantity),
      limitPrice: positiveNumberOrUndefined(record.limitPrice ?? record.price),
      currency: record.currency === "HKD" || record.currency === "USD" ? record.currency : "CNY",
      rationale: firstString(record.rationale, record.reason, record.text, candidate)
        ?? "Research-generated non-executable draft.",
      source: "research",
      requiresReview: true,
      executable: false,
    };
  });
}

function normalizeConclusion(value: unknown): ResearchConclusion {
  const normalized = firstString(value)?.toLowerCase();

  if (!normalized) {
    return "neutral";
  }

  if (["bull", "bullish", "buy", "positive", "看多"].includes(normalized)) {
    return "bullish";
  }

  if (["bear", "bearish", "sell", "negative", "看空"].includes(normalized)) {
    return "bearish";
  }

  if (["mixed", "conflicted", "分歧"].includes(normalized)) {
    return "mixed";
  }

  return "neutral";
}

function normalizeFindingCategory(value: unknown): ResearchFindingCategory {
  const normalized = firstString(value)?.toLowerCase();
  const allowed: ResearchFindingCategory[] = [
    "market",
    "technical",
    "fundamental",
    "news",
    "policy",
    "risk",
    "portfolio",
    "valuation",
    "sentiment",
    "other",
  ];

  return allowed.find((candidate) => candidate === normalized) ?? "other";
}

function normalizeRiskSeverity(value: unknown): RiskFactor["severity"] {
  const normalized = firstString(value)?.toLowerCase();

  if (normalized === "critical") {
    return "critical";
  }

  if (normalized === "warning" || normalized === "high") {
    return "warning";
  }

  if (normalized === "watch" || normalized === "medium") {
    return "watch";
  }

  return "info";
}

function normalizeSourceType(value: unknown): ResearchReport["sources"][number]["sourceType"] {
  const normalized = firstString(value)?.toLowerCase();

  if (normalized === "market") {
    return "market";
  }

  if (normalized === "news") {
    return "news";
  }

  if (normalized === "filing") {
    return "filing";
  }

  if (normalized === "research") {
    return "research";
  }

  if (normalized === "memory") {
    return "memory";
  }

  if (normalized === "user") {
    return "user";
  }

  if (normalized === "system") {
    return "system";
  }

  return "trading_agents_cn";
}

function normalizeDraftSide(value: unknown): TradeIntentDraft["side"] {
  const normalized = firstString(value)?.toLowerCase();

  if (normalized === "buy" || normalized === "买入") {
    return "BUY";
  }

  if (normalized === "sell" || normalized === "卖出") {
    return "SELL";
  }

  if (normalized === "hold" || normalized === "持有") {
    return "HOLD";
  }

  return "WATCH";
}

function normalizeConfidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    return 0.5;
  }

  if (parsed > 1 && parsed <= 100) {
    return roundRatio(parsed / 100);
  }

  return roundRatio(Math.max(0, Math.min(1, parsed)));
}

function detectExecutionFields(raw: Record<string, unknown>): string[] {
  return ["order", "orders", "execution", "executions", "trade", "trades", "broker"]
    .filter((key) => raw[key] !== undefined);
}

function toResearchProviderError(error: unknown): ResearchProviderError {
  if (error instanceof ResearchProviderError) {
    return error;
  }

  return new ResearchProviderError(`TradingAgents-CN research failed: ${String(error)}`, {
    cause: error,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function toStringArray(value: unknown): string[] {
  return toArray(value)
    .map((item) => firstString(item))
    .filter((item): item is string => Boolean(item));
}

function positiveIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 64) || "id";
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export type TradingAgentsCnAdaptedReport = ResearchReport;
export type TradingAgentsCnRawJson = JsonValue;
