import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  nonNegativeMoneySchema,
  stockMarketSchema,
  stockSymbolSchema,
  tradeDateSchema,
} from "../shared/index.js";

/**
 * Replay decisions (P1).
 *
 * A replay decision is the structured stance the assistant WOULD have taken at a
 * point in time, derived only from that snapshot's as-of context. It is always an
 * analysis artifact — `executable: false`, `reviewRequired: true` — never an order.
 * The forward outcome (what actually happened next) is a SEPARATE, clearly-fenced
 * evaluation input: future data may score a past decision, but must never feed it.
 */
export const replayBiasSchema = z.enum(["increase", "hold", "reduce"]);

/** Who produced the decision. Both are analysis-only; neither can execute anything. */
export const decisionGeneratorSchema = z.enum([
  "deterministic-replay-decider",
  "model-replay-decider",
]);

export const decisionTrendSchema = z.enum([
  "uptrend",
  "downtrend",
  "sideways",
  "insufficient_data",
]);

/** The as-of evidence the deterministic decider used — all <= the snapshot's asOfDate. */
export const decisionBasisSchema = z
  .object({
    trend: decisionTrendSchema,
    technicalAsOfDate: tradeDateSchema.nullable(),
    rangePosition60: z.number().finite().min(0).max(1).nullable(),
    closeVsMa20: z.number().finite().nullable(),
  })
  .strict();

export const decisionStanceSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80).nullable(),
    bias: replayBiasSchema,
    confidence: z.number().finite().min(0).max(1),
    rationale: z.string().trim().min(1).max(500),
    basis: decisionBasisSchema,
  })
  .strict();

export const replayDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: identifierSchema,
    snapshotId: identifierSchema,
    accountId: identifierSchema,
    alarmId: z.string().trim().min(1).max(64),
    asOfDate: tradeDateSchema,
    asOfTime: isoDateTimeSchema,
    stances: decisionStanceSchema.array(),
    // Safety: a replay decision is analysis only and can never be executed.
    executable: z.literal(false),
    reviewRequired: z.literal(true),
    generatedBy: decisionGeneratorSchema,
  })
  .strict();

/**
 * The realized forward outcome for one symbol — the FENCED look-ahead. `toDate` is
 * strictly after the decision's asOfDate; `realized` is false when there were not
 * enough forward trading days to evaluate yet (then the score is null, not zero).
 */
export const forwardOutcomeSchema = z
  .object({
    horizonTradingDays: z.number().int().positive(),
    /** The bar date the as-of close (return denominator) came from; forward bars are AFTER this. */
    fromDate: tradeDateSchema.nullable(),
    fromClose: nonNegativeMoneySchema.nullable(),
    realized: z.boolean(),
    toDate: tradeDateSchema.nullable(),
    toClose: nonNegativeMoneySchema.nullable(),
    forwardReturn: z.number().finite().nullable(),
  })
  .strict()
  .superRefine((outcome, context) => {
    // Canonical shapes: realized -> every field present (and forward); unrealized ->
    // every evaluation field null (so two "no data yet" states serialize identically).
    if (outcome.realized) {
      if (
        outcome.fromDate === null ||
        outcome.fromClose === null ||
        outcome.toDate === null ||
        outcome.toClose === null ||
        outcome.forwardReturn === null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "a realized outcome must carry fromDate/fromClose/toDate/toClose/forwardReturn",
        });
      } else if (outcome.toDate <= outcome.fromDate) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `forward outcome toDate ${outcome.toDate} must be after fromDate ${outcome.fromDate}`,
        });
      }
    } else if (
      outcome.fromDate !== null ||
      outcome.fromClose !== null ||
      outcome.toDate !== null ||
      outcome.toClose !== null ||
      outcome.forwardReturn !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an unrealized outcome must leave all from/to fields null",
      });
    }
  });

export const scoredStanceSchema = decisionStanceSchema
  .extend({
    forwardOutcome: forwardOutcomeSchema,
    /** null when unrealized (not yet scoreable); true/false once a forward return exists. */
    correct: z.boolean().nullable(),
  })
  .strict();

export const scoreSummarySchema = z
  .object({
    scoredCount: z.number().int().nonnegative(),
    hitCount: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
  })
  .strict();

export const scoredDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: identifierSchema,
    snapshotId: identifierSchema,
    accountId: identifierSchema,
    alarmId: z.string().trim().min(1).max(64),
    asOfDate: tradeDateSchema,
    asOfTime: isoDateTimeSchema,
    horizonTradingDays: z.number().int().positive(),
    returnThreshold: z.number().finite().min(0),
    stances: scoredStanceSchema.array(),
    summary: scoreSummarySchema,
    executable: z.literal(false),
    reviewRequired: z.literal(true),
    generatedBy: decisionGeneratorSchema,
    scoredBy: z.literal("forward-return-scorer"),
  })
  .strict();

const biasBreakdownSchema = z
  .object({
    scored: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
  })
  .strict();

/** Aggregate learning signal over many scored decisions — the seed of self-evolution. */
export const replayScorecardSchema = z
  .object({
    schemaVersion: z.literal(1),
    startDate: tradeDateSchema,
    endDate: tradeDateSchema,
    horizonTradingDays: z.number().int().positive(),
    returnThreshold: z.number().finite().min(0),
    decisionsCount: z.number().int().nonnegative(),
    scoredStances: z.number().int().nonnegative(),
    hitStances: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
    byBias: z
      .object({
        increase: biasBreakdownSchema,
        hold: biasBreakdownSchema,
        reduce: biasBreakdownSchema,
      })
      .strict(),
  })
  .strict();

/**
 * Soft experience (P1.1b).
 *
 * Lessons distilled retrospectively from scored decisions, grouped by market regime.
 * They are ADVISORY ONLY (`advisoryOnly: true`) — soft hints for future judgement,
 * never automatic changes to hard rules (those require human-reviewed proposals).
 */
export const experienceRangeBucketSchema = z.enum([
  "low", // < 0.33 of the 60-day range
  "mid", // [0.33, 0.66)
  "high", // [0.66, 0.85)
  "near_high", // >= 0.85 (追高区)
  "unknown", // rangePosition60 unavailable
]);

export const experienceVerdictSchema = z.enum([
  "favorable", // the bias tended to be right in this regime
  "unfavorable", // it tended to be wrong — review
  "mixed", // no clear edge
  "insufficient", // too few samples to conclude
]);

export const softLessonSchema = z
  .object({
    regime: z
      .object({
        trend: decisionTrendSchema,
        rangeBucket: experienceRangeBucketSchema,
        bias: replayBiasSchema,
      })
      .strict(),
    sampleSize: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
    verdict: experienceVerdictSchema,
    advice: z.string().trim().min(1).max(500),
  })
  .strict();

export const softExperienceReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    startDate: tradeDateSchema,
    endDate: tradeDateSchema,
    horizonTradingDays: z.number().int().positive(),
    returnThreshold: z.number().finite().min(0),
    decisionsAnalyzed: z.number().int().nonnegative(),
    scoredStances: z.number().int().nonnegative(),
    /**
     * The latest forward-outcome date that fed this report — i.e. the date by which
     * ALL its knowledge was observable. A decision may only use this experience if its
     * asOfDate is STRICTLY after this (the temporal fence against aggregate look-ahead).
     * null when nothing was scoreable.
     */
    coverageThroughDate: tradeDateSchema.nullable(),
    // Safety: experience is a soft hint, never a hard rule. Hard-wired true.
    advisoryOnly: z.literal(true),
    generatedBy: z.literal("soft-experience-distiller"),
    lessons: softLessonSchema.array(),
  })
  .strict();

/**
 * Walk-forward backtest (P2). The full range is processed window-by-window in date
 * order; each window's decisions may only be hinted by experience distilled from
 * STRICTLY-PRIOR windows (the temporal fence). The report records, per window, whether
 * prior experience was usable, plus an overall aggregate scorecard.
 */
export const walkForwardWindowSchema = z
  .object({
    windowStart: tradeDateSchema,
    windowEnd: tradeDateSchema,
    decisionsCount: z.number().int().nonnegative(),
    scoredStances: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
    /** Whether prior-window experience cleared the temporal fence for this window. */
    usedPriorExperience: z.boolean(),
    experienceCoverageThrough: tradeDateSchema.nullable(),
    experienceLessons: z.number().int().nonnegative(),
  })
  .strict();

export const walkForwardReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    startDate: tradeDateSchema,
    endDate: tradeDateSchema,
    windowDays: z.number().int().positive(),
    horizonTradingDays: z.number().int().positive(),
    returnThreshold: z.number().finite().min(0),
    decider: decisionGeneratorSchema,
    windowsCount: z.number().int().nonnegative(),
    windows: walkForwardWindowSchema.array(),
    overall: replayScorecardSchema,
    // Whole walk-forward is read-only analysis; experience feedback is advisory only.
    advisoryOnly: z.literal(true),
  })
  .strict();

/**
 * Decider comparison (P3). Runs the SAME windows/snapshots through several named
 * decider strategies (deterministic / model / model+experience) and reports each
 * one's scorecard side by side, so we can see whether self-evolution actually helps.
 */
export const deciderStrategyResultSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    decisionsCount: z.number().int().nonnegative(),
    scoredStances: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
  })
  .strict();

export const deciderComparisonReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    startDate: tradeDateSchema,
    endDate: tradeDateSchema,
    horizonTradingDays: z.number().int().positive(),
    returnThreshold: z.number().finite().min(0),
    strategies: deciderStrategyResultSchema.array(),
    /**
     * Best strategy by hit rate (tie → higher avg forward return → lexicographically
     * first name, for deterministic reproducibility), or null if none was scoreable.
     */
    best: z.string().nullable(),
    advisoryOnly: z.literal(true),
  })
  .strict();

/**
 * Strategy equity curve (P3). A PROXY metric: each realized stance contributes a signed
 * forward return by bias (increase → +r, reduce → -r, hold → 0), averaged per date and
 * compounded. Not a real-money P&L (no position sizing) — a directional-quality gauge.
 */
export const equityPointSchema = z
  .object({
    date: tradeDateSchema,
    signal: z.number().finite(),
    // Equity index is kept strictly positive by the signal floor in computeEquityCurve.
    equity: z.number().finite().nonnegative(),
  })
  .strict();

export const equityCurveSchema = z
  .object({
    schemaVersion: z.literal(1),
    startEquity: z.number().finite().nonnegative(),
    endEquity: z.number().finite().nonnegative(),
    totalReturn: z.number().finite(),
    // Drawdown is a ratio in [0, 1].
    maxDrawdown: z.number().finite().min(0).max(1),
    tradingDays: z.number().int().nonnegative(),
    points: equityPointSchema.array(),
  })
  .strict();

/**
 * Rule-change proposal (P3). When a regime is consistently favorable/unfavorable with
 * enough samples, the system PROPOSES a hard-rule change — but it is ALWAYS
 * `status: "pending_human_review"`, `autoApply: false`, `requiresHumanApproval: true`.
 * Soft experience can never silently become a hard rule.
 */
export const ruleChangeProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: identifierSchema,
    regime: z
      .object({
        trend: decisionTrendSchema,
        rangeBucket: experienceRangeBucketSchema,
        bias: replayBiasSchema,
      })
      .strict(),
    observedVerdict: experienceVerdictSchema,
    sampleSize: z.number().int().nonnegative(),
    hitRate: z.number().finite().min(0).max(1).nullable(),
    avgForwardReturn: z.number().finite().nullable(),
    recommendation: z.string().trim().min(1).max(500),
    sourceStart: tradeDateSchema,
    sourceEnd: tradeDateSchema,
    status: z.literal("pending_human_review"),
    autoApply: z.literal(false),
    requiresHumanApproval: z.literal(true),
    generatedBy: z.literal("experience-rule-proposer"),
  })
  .strict();

export type ReplayBias = z.infer<typeof replayBiasSchema>;
export type DecisionGenerator = z.infer<typeof decisionGeneratorSchema>;
export type WalkForwardWindow = z.infer<typeof walkForwardWindowSchema>;
export type WalkForwardReport = z.infer<typeof walkForwardReportSchema>;
export type DeciderStrategyResult = z.infer<typeof deciderStrategyResultSchema>;
export type DeciderComparisonReport = z.infer<typeof deciderComparisonReportSchema>;
export type EquityPoint = z.infer<typeof equityPointSchema>;
export type EquityCurve = z.infer<typeof equityCurveSchema>;
export type RuleChangeProposal = z.infer<typeof ruleChangeProposalSchema>;
export type ExperienceRangeBucket = z.infer<typeof experienceRangeBucketSchema>;
export type ExperienceVerdict = z.infer<typeof experienceVerdictSchema>;
export type SoftLesson = z.infer<typeof softLessonSchema>;
export type SoftExperienceReport = z.infer<typeof softExperienceReportSchema>;
export type DecisionBasis = z.infer<typeof decisionBasisSchema>;
export type DecisionStance = z.infer<typeof decisionStanceSchema>;
export type ReplayDecision = z.infer<typeof replayDecisionSchema>;
export type ForwardOutcome = z.infer<typeof forwardOutcomeSchema>;
export type ScoredStance = z.infer<typeof scoredStanceSchema>;
export type ScoreSummary = z.infer<typeof scoreSummarySchema>;
export type ScoredDecision = z.infer<typeof scoredDecisionSchema>;
export type ReplayScorecard = z.infer<typeof replayScorecardSchema>;
