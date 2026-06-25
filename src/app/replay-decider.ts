import {
  replayDecisionSchema,
  type DecisionStance,
  type ReplayBias,
  type ReplayDecision,
} from "../domain/decision/index.js";
import type {
  PointInTimeSnapshot,
  Position,
  SnapshotTechnical,
} from "../domain/portfolio/index.js";

type DecisionTrend = SnapshotTechnical["trend"];

/**
 * A pluggable decision strategy over a point-in-time snapshot. Implementations must
 * read ONLY the (as-of) snapshot and always return an analysis-only decision
 * (`executable: false`). The deterministic and model deciders both satisfy this.
 */
export interface ReplayDecider {
  decide(snapshot: PointInTimeSnapshot): Promise<ReplayDecision>;
}

/** The deterministic rule, adapted to the {@link ReplayDecider} seam. */
export const deterministicReplayDecider: ReplayDecider = {
  decide: async (snapshot) => decideFromSnapshot(snapshot),
};

/** Near the 60-day high —追高 risk; trim. */
const RANGE_TOPPING = 0.9;
/** Still room below the 60-day high — an uptrend may add. */
const RANGE_ROOM = 0.85;

/**
 * The deterministic stance rule, factored out as a pure function so it is directly
 * unit-testable across all branches. Trend + 60-day range position only — both are
 * as-of fields on the snapshot's technical, so this can never see the future.
 */
export function classifyReplayBias(
  trend: DecisionTrend,
  rangePosition60: number | null,
): { bias: ReplayBias; confidence: number } {
  if (trend === "insufficient_data" || rangePosition60 === null) {
    return { bias: "hold", confidence: 0.2 };
  }
  if (trend === "uptrend" && rangePosition60 < RANGE_ROOM) {
    return { bias: "increase", confidence: 0.6 };
  }
  if (trend === "downtrend" || rangePosition60 > RANGE_TOPPING) {
    return { bias: "reduce", confidence: 0.6 };
  }
  return { bias: "hold", confidence: 0.4 };
}

/**
 * The deterministic replay decider (P1.0 — no model yet, mirroring how P0 deferred
 * the brain). It is a PURE function of the snapshot: it reads only `snapshot.market`
 * (already bounded to <= asOfDate by P0), so it structurally cannot see the future.
 * Output is always an analysis stance (`executable: false`, `reviewRequired: true`).
 */
export function decideFromSnapshot(snapshot: PointInTimeSnapshot): ReplayDecision {
  const technicalBySymbol = new Map(
    snapshot.market.technicals.map((technical) => [technical.symbol, technical]),
  );

  const stances: DecisionStance[] = snapshot.positions.map((position) =>
    buildStance(position, technicalBySymbol.get(position.symbol) ?? null, snapshot),
  );

  return replayDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: snapshot.snapshotId.replace(/^snap-/, "dec-"),
    snapshotId: snapshot.snapshotId,
    accountId: snapshot.accountId,
    alarmId: snapshot.alarmId,
    asOfDate: snapshot.asOfDate,
    asOfTime: snapshot.asOfTime,
    stances,
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
  });
}

function buildStance(
  position: Position,
  technical: SnapshotTechnical | null,
  snapshot: PointInTimeSnapshot,
): DecisionStance {
  if (technical === null || technical.trend === "insufficient_data") {
    return {
      symbol: position.symbol,
      market: position.market,
      name: position.name,
      bias: "hold",
      confidence: 0.2,
      rationale: "无足够 as-of 行情/指标，保持不动。",
      basis: {
        trend: technical?.trend ?? "insufficient_data",
        technicalAsOfDate: technical?.asOfDate ?? null,
        rangePosition60: technical?.rangePosition60 ?? null,
        closeVsMa20: null,
      },
    };
  }

  const asOfClose = snapshot.market.prices[position.symbol] ?? null;
  const closeVsMa20 =
    technical.ma20 !== null && technical.ma20 > 0 && asOfClose !== null
      ? round6((asOfClose - technical.ma20) / technical.ma20)
      : null;

  const { bias, confidence } = classifyReplayBias(technical.trend, technical.rangePosition60);
  const rationale = rationaleFor(bias, technical);

  return {
    symbol: position.symbol,
    market: position.market,
    name: position.name,
    bias,
    confidence,
    rationale,
    basis: {
      trend: technical.trend,
      technicalAsOfDate: technical.asOfDate,
      rangePosition60: technical.rangePosition60,
      closeVsMa20,
    },
  };
}

function rationaleFor(bias: ReplayBias, technical: SnapshotTechnical): string {
  if (bias === "increase") {
    return `多头排列，且距 60 日高位仍有空间（位置 ${formatPct(technical.rangePosition60)}），可考虑加配。`;
  }
  if (bias === "reduce") {
    return technical.trend === "downtrend"
      ? "空头排列，建议减配控风险。"
      : `逼近 60 日高位（位置 ${formatPct(technical.rangePosition60)}），追高风险大，建议减配。`;
  }
  return "趋势中性，保持观望。";
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
