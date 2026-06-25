import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReplay } from "../../src/runtime/index.js";
import { ForwardOutcomeReader, scoreReplaySnapshots, type ScoreReplayResult } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import { DecisionMemoryStore } from "../../src/infrastructure/storage/index.js";
import { FIXED_CEREBELLUM_ALARM_RULES } from "../../src/domain/cerebellum/index.js";
import { pointInTimeSnapshotSchema } from "../../src/domain/portfolio/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

const SUBSET_IDS = new Set(["pre-market-plan", "closing-snapshot", "post-close-review"]);
const SUBSET_ALARMS = FIXED_CEREBELLUM_ALARM_RULES.filter((rule) => SUBSET_IDS.has(rule.alarmId));

let tmpDir: string;
let result: ScoreReplayResult;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "replay-scoring-"));

  const report = await runReplay({
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    account: replayAccount(),
    positions: replayPositions(),
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
    memoryDir: tmpDir,
    alarms: SUBSET_ALARMS,
    historyCount: 60,
    idGenerator: () => "evt-snap",
  });

  const snapshots = report.snapshots.map((record) =>
    pointInTimeSnapshotSchema.parse(JSON.parse(readFileSync(record.filePath, "utf8"))),
  );

  let counter = 0;
  result = await scoreReplaySnapshots({
    snapshots,
    forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(replayBarsBySymbol())),
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    horizonTradingDays: 1,
    returnThreshold: 0,
    store: new DecisionMemoryStore({
      memoryDir: tmpDir,
      idGenerator: () => `evt-${(counter += 1)}`,
    }),
  });
});

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("replay scoring (deterministic learning signal)", () => {
  it("scores every decision over the window", () => {
    expect(result.scorecard.decisionsCount).toBe(6);
    expect(result.scorecard.scoredStances).toBe(6); // all realized within the fixture
  });

  it("on a pure uptrend, the naive 'trim near highs' rule reduces into strength and misses", () => {
    // Every stance is 'reduce' (uptrend pinned at the 60-day high); price keeps rising,
    // so forward return > 0 and 'reduce' is wrong every time — a faithful, useful signal.
    expect(result.scorecard.byBias.reduce.scored).toBe(6);
    expect(result.scorecard.byBias.increase.scored).toBe(0);
    expect(result.scorecard.hitStances).toBe(0);
    expect(result.scorecard.hitRate).toBe(0);
    expect(result.scorecard.avgForwardReturn!).toBeGreaterThan(0);
  });

  it("anchors every forward outcome strictly after its fromDate (no overnight-gap leak)", () => {
    for (const decision of result.scored) {
      for (const stance of decision.stances) {
        if (stance.forwardOutcome.realized) {
          expect(stance.forwardOutcome.toDate! > stance.forwardOutcome.fromDate!).toBe(true);
        }
      }
    }
  });

  it("persists scored decisions with redacted audit (no per-stance returns)", () => {
    for (const decision of result.scored) {
      const decisionPath = path.join(tmpDir, "decisions", decision.asOfDate, `${decision.decisionId}.json`);
      expect(existsSync(decisionPath), `missing ${decisionPath}`).toBe(true);
    }

    const logsDir = path.join(tmpDir, "logs");
    let auditEvents = 0;
    for (const file of readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(path.join(logsDir, file), "utf8").trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.actor.id !== "decision-memory-store") {
          continue;
        }
        auditEvents += 1;
        const keys = Object.keys(event.metadata);
        expect(keys).toContain("hitRate");
        expect(keys).not.toContain("forwardReturn");
        expect(keys).not.toContain("stances");
        expect(event.metadata.executable).toBe(false);
        expect(event.metadata.reviewRequired).toBe(true);
      }
    }
    expect(auditEvents).toBe(6);
  });

  it("every scored decision stays non-executable and review-required", () => {
    for (const decision of result.scored) {
      expect(decision.executable).toBe(false);
      expect(decision.reviewRequired).toBe(true);
    }
  });
});
