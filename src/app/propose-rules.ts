import {
  ruleChangeProposalSchema,
  type ExperienceRangeBucket,
  type ReplayBias,
  type RuleChangeProposal,
  type SoftExperienceReport,
  type SoftLesson,
} from "../domain/decision/index.js";

export interface ProposeRuleChangesInput {
  report: SoftExperienceReport;
  /** Minimum sample size before a lesson is allowed to become a proposal (default 8). */
  minSamples?: number;
}

const DEFAULT_PROPOSAL_MIN_SAMPLES = 8;

type DecisionTrend = SoftLesson["regime"]["trend"];

/**
 * Turns consistently favorable/unfavorable soft lessons (with enough samples) into
 * hard-rule-change PROPOSALS. The output is the ONLY soft→hard bridge in the system,
 * and it is deliberately inert: every proposal is `status: "pending_human_review"`,
 * `autoApply: false`, `requiresHumanApproval: true`. Nothing here changes a rule — it
 * only drafts a suggestion for a human to review.
 */
export function proposeRuleChangesFromExperience(
  input: ProposeRuleChangesInput,
): RuleChangeProposal[] {
  const minSamples = input.minSamples ?? DEFAULT_PROPOSAL_MIN_SAMPLES;

  return input.report.lessons
    .filter(
      (lesson) =>
        (lesson.verdict === "favorable" || lesson.verdict === "unfavorable") &&
        lesson.sampleSize >= minSamples,
    )
    .map((lesson) =>
      ruleChangeProposalSchema.parse({
        schemaVersion: 1,
        proposalId: `ruleprop-${lesson.regime.trend}-${lesson.regime.rangeBucket}-${lesson.regime.bias}`,
        regime: lesson.regime,
        observedVerdict: lesson.verdict,
        sampleSize: lesson.sampleSize,
        hitRate: lesson.hitRate,
        avgForwardReturn: lesson.avgForwardReturn,
        recommendation: buildRecommendation(lesson),
        sourceStart: input.report.startDate,
        sourceEnd: input.report.endDate,
        status: "pending_human_review",
        autoApply: false,
        requiresHumanApproval: true,
        generatedBy: "experience-rule-proposer",
      }),
    );
}

const TREND_LABEL: Record<DecisionTrend, string> = {
  uptrend: "上涨",
  downtrend: "下跌",
  sideways: "震荡",
  insufficient_data: "数据不足",
};
const BUCKET_LABEL: Record<ExperienceRangeBucket, string> = {
  low: "低位",
  mid: "中位",
  high: "高位",
  near_high: "逼近高位",
  unknown: "位置未知",
};
const BIAS_LABEL: Record<ReplayBias, string> = {
  increase: "加配",
  hold: "保持",
  reduce: "减配",
};

function buildRecommendation(lesson: SoftLesson): string {
  const regime = `【${TREND_LABEL[lesson.regime.trend]}·${BUCKET_LABEL[lesson.regime.rangeBucket]}】`;
  const bias = BIAS_LABEL[lesson.regime.bias];
  const stats = `命中率 ${pct(lesson.hitRate)}、平均前瞻收益 ${pct(lesson.avgForwardReturn)}（样本 ${lesson.sampleSize}）`;
  const body =
    lesson.verdict === "unfavorable"
      ? `历史上“${bias}”在该形态表现差（${stats}）。提议：复核并考虑在该形态下弱化/取消“${bias}”倾向。`
      : `历史上“${bias}”在该形态表现良好（${stats}）。提议：复核并考虑在该形态下强化“${bias}”倾向。`;
  return `${regime} ${body}（需人工审核，绝不自动生效）`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}
