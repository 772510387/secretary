import {
  indexSnapshotSchema,
  marketAnomalySchema,
  type IndexId,
  type IndexSnapshot,
  type MarketAnomaly,
  type MarketAnomalySeverity,
} from "../market/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../notification/index.js";

const RATIO_DECIMALS = 6;

export interface IndexRiskRadarOptions {
  rapidDropThreshold?: number;
  rapidSurgeThreshold?: number;
  systemicRiskThreshold?: number;
  criticalDropThreshold?: number;
  minSystemicRiskIndexCount?: number;
  lookbackMs?: number;
  lookbackCount?: number;
}

export interface IndexRiskRadarInput {
  snapshots: readonly IndexSnapshot[];
  now?: Date | string;
  options?: IndexRiskRadarOptions;
}

export interface IndexRiskRadarResult {
  checkedAt: string;
  anomalies: MarketAnomaly[];
  notifications: NotificationEvent[];
}

interface NormalizedIndexRiskRadarOptions {
  rapidDropThreshold: number;
  rapidSurgeThreshold: number;
  systemicRiskThreshold: number;
  criticalDropThreshold: number;
  minSystemicRiskIndexCount: number;
  lookbackMs?: number;
  lookbackCount: number;
}

interface IndexComparison {
  latest: IndexSnapshot;
  previous: IndexSnapshot;
  changePct: number;
  lookbackMs: number;
  sampleSize: number;
}

export function detectIndexSystemicRisk(input: IndexRiskRadarInput): IndexRiskRadarResult {
  const checkedAt = normalizeDate(input.now).toISOString();
  const options = normalizeOptions(input.options);
  const snapshots = input.snapshots.map((snapshot) => indexSnapshotSchema.parse(snapshot));
  const comparisons = buildComparisons(snapshots, options);
  const anomalies = [
    ...comparisons.flatMap((comparison) => detectIndexMoveAnomalies(comparison, checkedAt, options)),
    ...detectSystemicRiskAnomalies(comparisons, checkedAt, options),
  ];

  return {
    checkedAt,
    anomalies,
    notifications: anomalies.map((anomaly) => notificationForAnomaly(anomaly)),
  };
}

function buildComparisons(
  snapshots: readonly IndexSnapshot[],
  options: NormalizedIndexRiskRadarOptions,
): IndexComparison[] {
  const byIndex = new Map<IndexId, IndexSnapshot[]>();

  for (const snapshot of snapshots) {
    const items = byIndex.get(snapshot.indexId) ?? [];
    items.push(snapshot);
    byIndex.set(snapshot.indexId, items);
  }

  const comparisons: IndexComparison[] = [];

  for (const items of byIndex.values()) {
    const sorted = [...items].sort((left, right) => snapshotTime(left) - snapshotTime(right));
    const latest = sorted[sorted.length - 1];

    if (!latest) {
      continue;
    }

    const previous = selectPreviousSnapshot(sorted, latest, options);

    if (!previous || previous.latestPrice <= 0) {
      continue;
    }

    comparisons.push({
      latest,
      previous,
      changePct: roundRatio((latest.latestPrice - previous.latestPrice) / previous.latestPrice),
      lookbackMs: Math.max(0, snapshotTime(latest) - snapshotTime(previous)),
      sampleSize: sorted.length,
    });
  }

  return comparisons;
}

function selectPreviousSnapshot(
  sorted: readonly IndexSnapshot[],
  latest: IndexSnapshot,
  options: NormalizedIndexRiskRadarOptions,
): IndexSnapshot | undefined {
  const latestTime = snapshotTime(latest);
  const previousItems = sorted.filter((snapshot) => snapshot !== latest && snapshotTime(snapshot) <= latestTime);

  if (previousItems.length === 0) {
    return undefined;
  }

  if (options.lookbackMs !== undefined) {
    const start = latestTime - options.lookbackMs;
    const candidates = previousItems.filter((snapshot) => snapshotTime(snapshot) >= start);
    return candidates[0] ?? previousItems[previousItems.length - 1];
  }

  const index = Math.max(0, previousItems.length - options.lookbackCount);
  return previousItems[index];
}

function detectIndexMoveAnomalies(
  comparison: IndexComparison,
  checkedAt: string,
  options: NormalizedIndexRiskRadarOptions,
): MarketAnomaly[] {
  if (comparison.changePct <= -options.rapidDropThreshold) {
    return [
      anomalyForComparison({
        comparison,
        checkedAt,
        anomalyType: "index_rapid_drop",
        severity: comparison.changePct <= -options.criticalDropThreshold ? "critical" : "warning",
        threshold: options.rapidDropThreshold,
        message: `${comparison.latest.name} dropped ${formatPct(comparison.changePct)} over the radar window`,
      }),
    ];
  }

  if (comparison.changePct >= options.rapidSurgeThreshold) {
    return [
      anomalyForComparison({
        comparison,
        checkedAt,
        anomalyType: "index_rapid_surge",
        severity: "watch",
        threshold: options.rapidSurgeThreshold,
        message: `${comparison.latest.name} surged ${formatPct(comparison.changePct)} over the radar window`,
      }),
    ];
  }

  return [];
}

function detectSystemicRiskAnomalies(
  comparisons: readonly IndexComparison[],
  checkedAt: string,
  options: NormalizedIndexRiskRadarOptions,
): MarketAnomaly[] {
  const dropped = comparisons.filter((comparison) => comparison.changePct <= -options.systemicRiskThreshold);

  if (dropped.length < options.minSystemicRiskIndexCount) {
    return [];
  }

  const averageDrop = roundRatio(
    dropped.reduce((sum, comparison) => sum + comparison.changePct, 0) / dropped.length,
  );

  return [
    marketAnomalySchema.parse({
      anomalyId: safeIdentifier(`anomaly-systemic-risk-${checkedAt.replace(/\D/g, "")}`),
      anomalyType: "systemic_risk",
      severity: averageDrop <= -options.criticalDropThreshold ? "critical" : "warning",
      targetType: "system",
      occurredAt: checkedAt,
      source: "index_risk_radar",
      message: `${dropped.length} indexes breached systemic risk threshold; average move ${formatPct(averageDrop)}`,
      changePct: averageDrop,
      threshold: options.systemicRiskThreshold,
      sampleSize: dropped.length,
      metadata: {
        indexIds: dropped.map((comparison) => comparison.latest.indexId),
        brokerConnected: false,
        brainProviderCalled: false,
        liveTrading: false,
      },
    }),
  ];
}

function anomalyForComparison(input: {
  comparison: IndexComparison;
  checkedAt: string;
  anomalyType: "index_rapid_drop" | "index_rapid_surge";
  severity: MarketAnomalySeverity;
  threshold: number;
  message: string;
}): MarketAnomaly {
  const { latest, previous } = input.comparison;

  return marketAnomalySchema.parse({
    anomalyId: safeIdentifier(
      `anomaly-${input.anomalyType}-${latest.indexId}-${input.checkedAt.replace(/\D/g, "")}`,
    ),
    anomalyType: input.anomalyType,
    severity: input.severity,
    targetType: "index",
    occurredAt: input.checkedAt,
    source: "index_risk_radar",
    message: input.message,
    indexId: latest.indexId,
    code: latest.code,
    market: latest.market,
    name: latest.name,
    currentValue: latest.latestPrice,
    previousValue: previous.latestPrice,
    changePct: input.comparison.changePct,
    threshold: input.threshold,
    lookbackMs: input.comparison.lookbackMs,
    sampleSize: input.comparison.sampleSize,
    metadata: {
      rawSymbol: latest.rawSymbol,
      tradingAllowed: latest.tradingAllowed,
      brokerConnected: false,
      brainProviderCalled: false,
      liveTrading: false,
    },
  });
}

function notificationForAnomaly(anomaly: MarketAnomaly): NotificationEvent {
  const eventId = safeIdentifier(`notification-${anomaly.anomalyId}`);

  return notificationEventSchema.parse({
    eventId,
    occurredAt: anomaly.occurredAt,
    severity: anomaly.severity,
    source: {
      type: "cerebellum",
      id: "index-risk-radar",
      name: "Index risk radar",
    },
    target: {
      type: "system",
      id: anomaly.targetType === "index" ? safeIdentifier(anomaly.indexId ?? anomaly.code ?? "index") : "market",
      name: anomaly.name ?? "market",
    },
    summary: anomaly.message,
    recommendedAction: "Review market risk context manually; this alert is not a broker order.",
    correlationId: anomaly.anomalyId,
    dedupeKey: `${anomaly.anomalyType}:${anomaly.indexId ?? "market"}`,
    cooldownKey: `${anomaly.anomalyType}:${anomaly.indexId ?? "market"}`,
    channels: ["console", "file"],
    metadata: {
      anomalyType: anomaly.anomalyType,
      source: anomaly.source,
      changePct: anomaly.changePct ?? null,
      threshold: anomaly.threshold ?? null,
      brokerConnected: false,
      brainProviderCalled: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function normalizeOptions(options: IndexRiskRadarOptions = {}): NormalizedIndexRiskRadarOptions {
  const normalized = {
    rapidDropThreshold: options.rapidDropThreshold ?? 0.01,
    rapidSurgeThreshold: options.rapidSurgeThreshold ?? 0.01,
    systemicRiskThreshold: options.systemicRiskThreshold ?? 0.008,
    criticalDropThreshold: options.criticalDropThreshold ?? 0.02,
    minSystemicRiskIndexCount: options.minSystemicRiskIndexCount ?? 2,
    lookbackMs: options.lookbackMs,
    lookbackCount: options.lookbackCount ?? 1,
  };

  assertRatio(normalized.rapidDropThreshold, "rapidDropThreshold");
  assertRatio(normalized.rapidSurgeThreshold, "rapidSurgeThreshold");
  assertRatio(normalized.systemicRiskThreshold, "systemicRiskThreshold");
  assertRatio(normalized.criticalDropThreshold, "criticalDropThreshold");

  if (!Number.isInteger(normalized.minSystemicRiskIndexCount) || normalized.minSystemicRiskIndexCount <= 0) {
    throw new IndexRiskRadarError("minSystemicRiskIndexCount must be a positive integer");
  }

  if (!Number.isInteger(normalized.lookbackCount) || normalized.lookbackCount <= 0) {
    throw new IndexRiskRadarError("lookbackCount must be a positive integer");
  }

  if (
    normalized.lookbackMs !== undefined &&
    (!Number.isInteger(normalized.lookbackMs) || normalized.lookbackMs <= 0)
  ) {
    throw new IndexRiskRadarError("lookbackMs must be a positive integer when provided");
  }

  return normalized;
}

function snapshotTime(snapshot: IndexSnapshot): number {
  return Date.parse(snapshot.providerTime ?? snapshot.receivedAt);
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new IndexRiskRadarError("Invalid index risk radar date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new IndexRiskRadarError(`Invalid index risk radar date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new IndexRiskRadarError(`${name} must be between 0 and 1`);
  }
}

function roundRatio(value: number): number {
  const factor = 10 ** RATIO_DECIMALS;
  const epsilon = Number.EPSILON * Math.sign(value || 1);
  return Math.round((value + epsilon) * factor) / factor;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "index-risk-radar";
}

export class IndexRiskRadarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexRiskRadarError";
  }
}
