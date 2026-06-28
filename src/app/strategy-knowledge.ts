import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  scoredDecisionSchema,
  type ReplayBias,
  type ScoredDecision,
  type ScoredStance,
} from "../domain/decision/index.js";
import {
  DEFAULT_NAMED_STRATEGIES,
  deriveStrategyIdsForStance,
  namedStrategySchema,
  strategyKnowledgeEntrySchema,
  strategyMetricSchema,
  type NamedStrategy,
  type StrategyKnowledgeEntry,
  type StrategyMetric,
} from "../domain/strategy/index.js";

export interface BuildStrategyKnowledgeDigestInput {
  memoryDir?: string;
  /** Test seam or caller-provided scored decisions; when absent, reads memory/decisions. */
  scoredDecisions?: readonly ScoredDecision[];
  strategies?: readonly NamedStrategy[];
  focusStrategyId?: string;
  maxCases?: number;
  asOfDate?: string;
}

export interface StrategyCaseSummary {
  caseId: string;
  strategyId: string;
  decisionId: string;
  date: string;
  symbol: string;
  name: string | null;
  action: ReplayBias;
  outcome: "success" | "failed" | "holding";
  forwardReturn: number | null;
  rationale: string;
}

export interface StrategyDecisionLogSummary {
  decisionId: string;
  date: string;
  symbol: string;
  name: string | null;
  action: ReplayBias;
  strategyIds: string[];
  rationale: string;
}

export interface StrategyKnowledgeDigest {
  generatedAt: string;
  asOfDate?: string;
  strategies: StrategyKnowledgeEntry[];
  cases: StrategyCaseSummary[];
  decisions: StrategyDecisionLogSummary[];
  mechanism: string[];
  notes: string[];
}

interface StrategyAccumulator {
  strategy: NamedStrategy;
  decisionRefs: number;
  sampleSize: number;
  hits: number;
  returnSum: number;
}

const DEFAULT_MAX_CASES = 10;

export function buildStrategyKnowledgeDigest(
  input: BuildStrategyKnowledgeDigestInput = {},
): StrategyKnowledgeDigest {
  const catalog = normalizeStrategies(input.strategies ?? DEFAULT_NAMED_STRATEGIES);
  const catalogById = new Map(catalog.map((strategy) => [strategy.strategyId, strategy]));
  const focus = input.focusStrategyId?.trim();
  const maxCases = input.maxCases ?? DEFAULT_MAX_CASES;
  const scored = input.scoredDecisions
    ? [...input.scoredDecisions]
    : input.memoryDir
      ? readScoredDecisions(input.memoryDir)
      : [];

  const accumulators = new Map<string, StrategyAccumulator>();
  for (const strategy of catalog) {
    if (!focus || strategy.strategyId === focus) {
      accumulators.set(strategy.strategyId, emptyAccumulator(strategy));
    }
  }

  const cases: StrategyCaseSummary[] = [];
  const decisions: StrategyDecisionLogSummary[] = [];

  for (const decision of scored.sort(byDecisionTime)) {
    for (const stance of decision.stances) {
      const strategyIds = resolveStrategyIds(stance).filter((strategyId) => !focus || strategyId === focus);
      if (strategyIds.length === 0) {
        continue;
      }

      decisions.push(toDecisionLog(decision, stance, strategyIds));
      for (const strategyId of strategyIds) {
        const acc = ensureAccumulator(accumulators, catalogById, strategyId);
        acc.decisionRefs += 1;

        if (stance.forwardOutcome.realized && stance.forwardOutcome.forwardReturn !== null) {
          acc.sampleSize += 1;
          acc.returnSum += stance.forwardOutcome.forwardReturn;
          if (stance.correct === true) {
            acc.hits += 1;
          }
        }

        cases.push(toCase(decision, stance, strategyId));
      }
    }
  }

  const strategies = [...accumulators.values()]
    .map(toKnowledgeEntry)
    .sort((left, right) => left.priority - right.priority || left.strategyId.localeCompare(right.strategyId));

  const renderedCases = cases
    .sort((left, right) => right.date.localeCompare(left.date) || right.caseId.localeCompare(left.caseId))
    .slice(0, maxCases);
  const renderedDecisions = decisions
    .sort((left, right) => right.date.localeCompare(left.date) || right.decisionId.localeCompare(left.decisionId))
    .slice(0, maxCases);

  return {
    generatedAt: new Date().toISOString(),
    asOfDate: input.asOfDate,
    strategies,
    cases: renderedCases,
    decisions: renderedDecisions,
    mechanism: [
      "决策前：查询命名策略、历史样本和案例反链，作为大脑的证据包。",
      "决策时：每个 stance 记录 strategyIds，解释基于哪条策略，但不赋予交易权限。",
      "决策后：forward-return scorer 回填结果，胜率和平均收益由代码派生。",
      "复盘时：成功/失败/持仓中案例从已评分决策生成，供下次 Feishu 交互引用。",
      "定期：样本足够后给出提炼或人工复核建议；硬规则变更仍走提案链。",
    ],
    notes: buildNotes(scored.length, cases.length),
  };
}

export function renderStrategyKnowledgeDigest(digest: StrategyKnowledgeDigest): string {
  const lines: string[] = [
    "【策略知识库总览】",
    "实现形态：命名策略层 + 已评分决策派生统计。模型只负责解释，胜率/案例/状态建议由代码计算。",
    `策略 ${digest.strategies.length} 条，案例 ${digest.cases.length} 个，决策引用 ${digest.decisions.length} 条。`,
  ];

  if (digest.asOfDate) {
    lines.push(`统计日期：${digest.asOfDate}`);
  }

  lines.push("", "策略库", "ID | 名称 | 类别 | 案例 | 胜率 | 状态建议");
  for (const strategy of digest.strategies) {
    lines.push(
      [
        strategy.strategyId,
        strategy.name,
        categoryLabel(strategy.category),
        String(strategy.metrics.sampleSize),
        formatRate(strategy.metrics.hitRate),
        strategy.metrics.lifecycleSuggestion,
      ].join(" | "),
    );
  }

  lines.push("", "案例库（最近）");
  if (digest.cases.length === 0) {
    lines.push("暂无已评分案例；先按种子策略待验证展示，回放/模拟闭环跑起来后会自动沉淀。");
  } else {
    for (const item of digest.cases) {
      lines.push(
        `${item.caseId} | ${item.date} | ${item.name ?? item.symbol} | ${outcomeLabel(item.outcome)} | ${formatRate(item.forwardReturn)}`,
      );
    }
  }

  lines.push("", "决策日志（最近）");
  if (digest.decisions.length === 0) {
    lines.push("暂无 strategyIds 决策引用。");
  } else {
    for (const item of digest.decisions) {
      lines.push(
        `${item.decisionId} | ${item.date} | ${biasLabel(item.action)} ${item.name ?? item.symbol} | ${item.strategyIds.join(", ")}`,
      );
    }
  }

  lines.push("", "增长机制");
  digest.mechanism.forEach((item, index) => lines.push(`${index + 1}. ${item}`));

  if (digest.notes.length > 0) {
    lines.push("", "当前提示");
    digest.notes.forEach((item) => lines.push(`- ${item}`));
  }

  return lines.join("\n");
}

function readScoredDecisions(memoryDir: string): ScoredDecision[] {
  const decisionsDir = path.join(path.resolve(memoryDir), "decisions");
  if (!existsSync(decisionsDir)) {
    return [];
  }
  const out: ScoredDecision[] = [];
  for (const dateDir of safeReaddir(decisionsDir).sort()) {
    const fullDateDir = path.join(decisionsDir, dateDir);
    for (const file of safeReaddir(fullDateDir).sort()) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        out.push(scoredDecisionSchema.parse(JSON.parse(readFileSync(path.join(fullDateDir, file), "utf8"))));
      } catch {
        // One corrupt artifact must not hide the rest of the strategy knowledge base.
      }
    }
  }
  return out;
}

function normalizeStrategies(strategies: readonly NamedStrategy[]): NamedStrategy[] {
  return strategies.map((strategy) => namedStrategySchema.parse(strategy));
}

function emptyAccumulator(strategy: NamedStrategy): StrategyAccumulator {
  return { strategy, decisionRefs: 0, sampleSize: 0, hits: 0, returnSum: 0 };
}

function ensureAccumulator(
  accumulators: Map<string, StrategyAccumulator>,
  catalogById: Map<string, NamedStrategy>,
  strategyId: string,
): StrategyAccumulator {
  const existing = accumulators.get(strategyId);
  if (existing) {
    return existing;
  }
  const strategy =
    catalogById.get(strategyId) ??
    namedStrategySchema.parse({
      strategyId,
      name: strategyId,
      category: "risk",
      description: "外部或历史决策引用的策略 ID，当前 catalog 未定义。",
      status: "watch",
      priority: 999,
      regimeFingerprint: {},
      source: "memory",
    });
  const created = emptyAccumulator(strategy);
  accumulators.set(strategyId, created);
  return created;
}

function resolveStrategyIds(stance: ScoredStance): string[] {
  const explicit = stance.strategyIds?.filter((strategyId) => strategyId.trim() !== "") ?? [];
  if (explicit.length > 0) {
    return [...new Set(explicit)].sort();
  }
  return deriveStrategyIdsForStance({ bias: stance.bias, basis: stance.basis });
}

function toKnowledgeEntry(acc: StrategyAccumulator): StrategyKnowledgeEntry {
  const hitRate = acc.sampleSize > 0 ? round6(acc.hits / acc.sampleSize) : null;
  const avgForwardReturn = acc.sampleSize > 0 ? round6(acc.returnSum / acc.sampleSize) : null;
  const metrics: StrategyMetric = strategyMetricSchema.parse({
    strategyId: acc.strategy.strategyId,
    sampleSize: acc.sampleSize,
    hits: acc.hits,
    hitRate,
    avgForwardReturn,
    decisionRefs: acc.decisionRefs,
    lifecycleSuggestion: lifecycleSuggestion(acc.sampleSize, hitRate),
  });
  return strategyKnowledgeEntrySchema.parse({ ...acc.strategy, metrics });
}

function toCase(decision: ScoredDecision, stance: ScoredStance, strategyId: string): StrategyCaseSummary {
  const realized = stance.forwardOutcome.realized && stance.forwardOutcome.forwardReturn !== null;
  const outcome: StrategyCaseSummary["outcome"] = realized
    ? stance.correct === true
      ? "success"
      : "failed"
    : "holding";
  return {
    caseId: `CASE-${decision.asOfDate.replaceAll("-", "")}-${strategyId}-${stance.symbol}`.slice(0, 128),
    strategyId,
    decisionId: decision.decisionId,
    date: decision.asOfDate,
    symbol: stance.symbol,
    name: stance.name,
    action: stance.bias,
    outcome,
    forwardReturn: stance.forwardOutcome.forwardReturn,
    rationale: stance.rationale,
  };
}

function toDecisionLog(
  decision: ScoredDecision,
  stance: ScoredStance,
  strategyIds: string[],
): StrategyDecisionLogSummary {
  return {
    decisionId: decision.decisionId,
    date: decision.asOfDate,
    symbol: stance.symbol,
    name: stance.name,
    action: stance.bias,
    strategyIds,
    rationale: stance.rationale,
  };
}

function buildNotes(decisionCount: number, caseCount: number): string[] {
  const notes: string[] = [];
  if (decisionCount === 0) {
    notes.push("memory/decisions 尚无已评分决策；需要跑 replay/scorer 或模拟闭环后才会有真实样本。");
  }
  if (caseCount === 0) {
    notes.push("当前所有策略仍应按待验证处理，不应因种子策略存在而提高交易权限。");
  }
  notes.push("策略提炼或淘汰只输出建议，不自动修改硬规则。");
  return notes;
}

function lifecycleSuggestion(sampleSize: number, hitRate: number | null): StrategyMetric["lifecycleSuggestion"] {
  if (sampleSize < 3 || hitRate === null) {
    return "待验证";
  }
  if (hitRate >= 0.6) {
    return "建议提炼";
  }
  if (hitRate <= 0.4) {
    return "建议人工复核";
  }
  return "继续观察";
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function byDecisionTime(left: ScoredDecision, right: ScoredDecision): number {
  return left.asOfTime.localeCompare(right.asOfTime) || left.decisionId.localeCompare(right.decisionId);
}

function categoryLabel(category: NamedStrategy["category"]): string {
  switch (category) {
    case "buy":
      return "买入";
    case "sell":
      return "卖出";
    case "position":
      return "仓位";
    case "risk":
      return "风控";
  }
}

function outcomeLabel(outcome: StrategyCaseSummary["outcome"]): string {
  if (outcome === "success") {
    return "成功";
  }
  if (outcome === "failed") {
    return "失败";
  }
  return "持仓中";
}

function biasLabel(bias: ReplayBias): string {
  if (bias === "increase") {
    return "加配";
  }
  if (bias === "reduce") {
    return "减配";
  }
  return "保持";
}

function formatRate(value: number | null): string {
  return value === null ? "待验证" : `${(value * 100).toFixed(2)}%`;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
