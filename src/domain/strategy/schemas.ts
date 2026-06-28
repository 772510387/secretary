import { z } from "zod";
import {
  decisionTrendSchema,
  experienceRangeBucketSchema,
  replayBiasSchema,
  type DecisionBasis,
  type ExperienceRangeBucket,
  type ReplayBias,
  type SoftLesson,
} from "../decision/index.js";
import { identifierSchema } from "../shared/index.js";

export const strategyCategorySchema = z.enum(["buy", "sell", "position", "risk"]);
export const strategyStatusSchema = z.enum(["active", "watch", "deprecated"]);

export const strategyRegimeFingerprintSchema = z
  .object({
    trends: decisionTrendSchema.array().min(1).optional(),
    rangeBuckets: experienceRangeBucketSchema.array().min(1).optional(),
    biases: replayBiasSchema.array().min(1).optional(),
  })
  .strict();

export const namedStrategySchema = z
  .object({
    strategyId: identifierSchema,
    name: z.string().trim().min(1).max(80),
    category: strategyCategorySchema,
    description: z.string().trim().min(1).max(500),
    status: strategyStatusSchema,
    priority: z.number().int().nonnegative().max(1000),
    regimeFingerprint: strategyRegimeFingerprintSchema,
    source: z.enum(["seed", "memory"]).default("seed"),
  })
  .strict();

export const strategyMetricSchema = z
  .object({
    strategyId: identifierSchema,
    sampleSize: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
    decisionRefs: z.number().int().nonnegative(),
    lifecycleSuggestion: z.enum(["待验证", "继续观察", "建议提炼", "建议人工复核"]),
  })
  .strict();

export const strategyKnowledgeEntrySchema = namedStrategySchema
  .extend({
    metrics: strategyMetricSchema,
  })
  .strict();

export type StrategyCategory = z.infer<typeof strategyCategorySchema>;
export type StrategyStatus = z.infer<typeof strategyStatusSchema>;
export type StrategyRegimeFingerprint = z.infer<typeof strategyRegimeFingerprintSchema>;
export type NamedStrategy = z.infer<typeof namedStrategySchema>;
export type StrategyMetric = z.infer<typeof strategyMetricSchema>;
export type StrategyKnowledgeEntry = z.infer<typeof strategyKnowledgeEntrySchema>;

export const DEFAULT_NAMED_STRATEGIES: readonly NamedStrategy[] = namedStrategySchema.array().parse([
  {
    strategyId: "BUY-001",
    name: "深水错杀低吸",
    category: "buy",
    description: "低位或恐慌后出现错杀时，只在证据充分且仓位允许时低吸；样本不足时只作软提示。",
    status: "active",
    priority: 10,
    regimeFingerprint: { rangeBuckets: ["low"], biases: ["increase"] },
    source: "seed",
  },
  {
    strategyId: "BUY-002",
    name: "主线低位补涨",
    category: "buy",
    description: "主线方向中仍未逼近阶段高位的补涨标的，优先看趋势和量能确认。",
    status: "active",
    priority: 20,
    regimeFingerprint: { trends: ["uptrend"], rangeBuckets: ["mid", "high"], biases: ["increase"] },
    source: "seed",
  },
  {
    strategyId: "SELL-001",
    name: "高潮次日止盈",
    category: "sell",
    description: "涨幅接近阶段高位或情绪高潮后，优先考虑分批止盈而不是继续追高。",
    status: "active",
    priority: 30,
    regimeFingerprint: { rangeBuckets: ["near_high"], biases: ["reduce"] },
    source: "seed",
  },
  {
    strategyId: "POSITION-001",
    name: "334 仓位管理",
    category: "position",
    description: "不确定时以分批和仓位纪律控制回撤；保持观望也必须有依据。",
    status: "active",
    priority: 40,
    regimeFingerprint: { biases: ["hold"] },
    source: "seed",
  },
  {
    strategyId: "RISK-001",
    name: "恐慌极点逆向",
    category: "risk",
    description: "下跌趋势或恐慌环境下优先识别风险，只有人工复核后才讨论逆向机会。",
    status: "active",
    priority: 50,
    regimeFingerprint: { trends: ["downtrend"], biases: ["reduce"] },
    source: "seed",
  },
]);

export function deriveStrategyIdsForStance(input: {
  bias: ReplayBias;
  basis: Pick<DecisionBasis, "trend" | "rangePosition60">;
}): string[] {
  return matchNamedStrategiesForRegime({
    trend: input.basis.trend,
    rangeBucket: strategyRangeBucketOf(input.basis.rangePosition60),
    bias: input.bias,
  }).map((strategy) => strategy.strategyId);
}

export function matchNamedStrategiesForRegime(
  regime: {
    trend: SoftLesson["regime"]["trend"];
    rangeBucket: ExperienceRangeBucket;
    bias: ReplayBias;
  },
  strategies: readonly NamedStrategy[] = DEFAULT_NAMED_STRATEGIES,
): NamedStrategy[] {
  return [...strategies]
    .filter((strategy) => matchesFingerprint(strategy.regimeFingerprint, regime))
    .sort((left, right) => left.priority - right.priority || left.strategyId.localeCompare(right.strategyId));
}

export function strategyRangeBucketOf(rangePosition60: number | null): ExperienceRangeBucket {
  if (rangePosition60 === null) {
    return "unknown";
  }
  if (rangePosition60 < 0.33) {
    return "low";
  }
  if (rangePosition60 < 0.66) {
    return "mid";
  }
  if (rangePosition60 < 0.85) {
    return "high";
  }
  return "near_high";
}

function matchesFingerprint(
  fingerprint: StrategyRegimeFingerprint,
  regime: {
    trend: SoftLesson["regime"]["trend"];
    rangeBucket: ExperienceRangeBucket;
    bias: ReplayBias;
  },
): boolean {
  if (fingerprint.trends && !fingerprint.trends.includes(regime.trend)) {
    return false;
  }
  if (fingerprint.rangeBuckets && !fingerprint.rangeBuckets.includes(regime.rangeBucket)) {
    return false;
  }
  if (fingerprint.biases && !fingerprint.biases.includes(regime.bias)) {
    return false;
  }
  return true;
}
