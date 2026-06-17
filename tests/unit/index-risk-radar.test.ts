import { describe, expect, it } from "vitest";
import {
  IndexRiskRadarError,
  detectIndexSystemicRisk,
} from "../../src/domain/cerebellum/index.js";
import {
  indexSnapshotSchema,
  type IndexId,
  type IndexSnapshot,
} from "../../src/domain/market/index.js";

describe("index risk radar", () => {
  it("detects an index rapid drop and builds a non-executable notification", () => {
    const result = detectIndexSystemicRisk({
      now: "2026-06-16T01:31:00.000Z",
      snapshots: [
        makeIndexSnapshot({
          latestPrice: 3000,
          receivedAt: "2026-06-16T01:30:00.000Z",
        }),
        makeIndexSnapshot({
          latestPrice: 2960,
          receivedAt: "2026-06-16T01:31:00.000Z",
        }),
      ],
      options: {
        lookbackMs: 60_000,
        rapidDropThreshold: 0.01,
      },
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      anomalyType: "index_rapid_drop",
      severity: "warning",
      indexId: "sse_composite",
      changePct: -0.013333,
      lookbackMs: 60_000,
      metadata: {
        tradingAllowed: false,
        brokerConnected: false,
        brainProviderCalled: false,
        liveTrading: false,
      },
    });
    expect(result.notifications[0]).toMatchObject({
      severity: "warning",
      channels: ["console", "file"],
      metadata: {
        directExecutionAllowed: false,
        brokerConnected: false,
        liveTrading: false,
      },
    });
  });

  it("detects systemic risk when multiple indexes breach the deterministic threshold", () => {
    const result = detectIndexSystemicRisk({
      now: "2026-06-16T01:31:00.000Z",
      snapshots: [
        makeIndexSnapshot({
          indexId: "sse_composite",
          code: "000001",
          rawSymbol: "sh000001",
          latestPrice: 3000,
          receivedAt: "2026-06-16T01:30:00.000Z",
        }),
        makeIndexSnapshot({
          indexId: "sse_composite",
          code: "000001",
          rawSymbol: "sh000001",
          latestPrice: 2968,
          receivedAt: "2026-06-16T01:31:00.000Z",
        }),
        makeIndexSnapshot({
          indexId: "szse_component",
          code: "399001",
          rawSymbol: "sz399001",
          market: "SZSE",
          latestPrice: 10000,
          receivedAt: "2026-06-16T01:30:00.000Z",
        }),
        makeIndexSnapshot({
          indexId: "szse_component",
          code: "399001",
          rawSymbol: "sz399001",
          market: "SZSE",
          latestPrice: 9900,
          receivedAt: "2026-06-16T01:31:00.000Z",
        }),
      ],
      options: {
        systemicRiskThreshold: 0.008,
        minSystemicRiskIndexCount: 2,
      },
    });

    expect(result.anomalies.some((anomaly) => anomaly.anomalyType === "systemic_risk")).toBe(true);
    expect(result.anomalies.find((anomaly) => anomaly.anomalyType === "systemic_risk")).toMatchObject({
      targetType: "system",
      severity: "warning",
      sampleSize: 2,
      metadata: {
        indexIds: ["sse_composite", "szse_component"],
        brokerConnected: false,
        brainProviderCalled: false,
      },
    });
  });

  it("can compare against a configurable lookback count and detect a rapid surge", () => {
    const result = detectIndexSystemicRisk({
      now: "2026-06-16T01:32:00.000Z",
      snapshots: [
        makeIndexSnapshot({
          indexId: "chinext",
          code: "399006",
          rawSymbol: "sz399006",
          market: "SZSE",
          latestPrice: 2000,
          receivedAt: "2026-06-16T01:30:00.000Z",
        }),
        makeIndexSnapshot({
          indexId: "chinext",
          code: "399006",
          rawSymbol: "sz399006",
          market: "SZSE",
          latestPrice: 2010,
          receivedAt: "2026-06-16T01:31:00.000Z",
        }),
        makeIndexSnapshot({
          indexId: "chinext",
          code: "399006",
          rawSymbol: "sz399006",
          market: "SZSE",
          latestPrice: 2045,
          receivedAt: "2026-06-16T01:32:00.000Z",
        }),
      ],
      options: {
        lookbackCount: 2,
        rapidSurgeThreshold: 0.02,
      },
    });

    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0]).toMatchObject({
      anomalyType: "index_rapid_surge",
      severity: "watch",
      indexId: "chinext",
      changePct: 0.0225,
    });
  });

  it("rejects invalid thresholds before creating anomalies", () => {
    expect(() =>
      detectIndexSystemicRisk({
        snapshots: [],
        options: {
          rapidDropThreshold: -0.01,
        },
      }),
    ).toThrow(IndexRiskRadarError);
  });
});

function makeIndexSnapshot(overrides: Partial<IndexSnapshot> = {}): IndexSnapshot {
  const indexId = overrides.indexId ?? "sse_composite";

  return indexSnapshotSchema.parse({
    indexId,
    code: overrides.code ?? defaultCode(indexId),
    market: overrides.market ?? (indexId === "sse_composite" || indexId === "star50" ? "SSE" : "SZSE"),
    name: overrides.name ?? "上证指数",
    provider: "tencent",
    latestPrice: overrides.latestPrice ?? 3000,
    previousClose: overrides.previousClose ?? overrides.latestPrice ?? 3000,
    changePct: overrides.changePct ?? 0,
    receivedAt: overrides.receivedAt ?? "2026-06-16T01:30:00.000Z",
    rawSymbol: overrides.rawSymbol ?? "sh000001",
    tradingAllowed: false,
  });
}

function defaultCode(indexId: IndexId): string {
  switch (indexId) {
    case "sse_composite":
      return "000001";
    case "szse_component":
      return "399001";
    case "chinext":
      return "399006";
    case "star50":
      return "000688";
  }
}
