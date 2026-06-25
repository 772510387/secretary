import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWalkForward, type WalkForwardResult } from "../../src/runtime/index.js";
import { deterministicReplayDecider } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import { FIXED_CEREBELLUM_ALARM_RULES } from "../../src/domain/cerebellum/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

const CLOSING_ONLY = FIXED_CEREBELLUM_ALARM_RULES.filter((rule) => rule.alarmId === "closing-snapshot");

const tmpDirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "walk-forward-"));
  tmpDirs.push(dir);
  return dir;
}

async function run(): Promise<WalkForwardResult> {
  return runWalkForward({
    startDate: "2026-06-08",
    endDate: "2026-06-19",
    account: replayAccount(),
    positions: replayPositions(),
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
    memoryDir: freshDir(),
    windowDays: 4,
    horizonTradingDays: 1,
    returnThreshold: 0,
    alarms: CLOSING_ONLY,
    historyCount: 60,
    makeDecider: () => deterministicReplayDecider,
    deciderKind: "deterministic-replay-decider",
  });
}

let result: WalkForwardResult;

beforeAll(async () => {
  result = await run();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("walk-forward backtest", () => {
  it("splits the range into multiple date windows", () => {
    expect(result.report.windowsCount).toBeGreaterThanOrEqual(2);
    expect(result.report.windows.length).toBe(result.report.windowsCount);
    expect(result.report.decider).toBe("deterministic-replay-decider");
    expect(result.report.advisoryOnly).toBe(true);
  });

  it("the first window has no prior experience; a later window does (the fence rolls)", () => {
    const windows = result.report.windows;
    expect(windows[0]!.usedPriorExperience).toBe(false);
    expect(windows[0]!.experienceCoverageThrough).toBeNull();
    // by the last window, prior windows' outcomes have realized and clear the fence
    expect(windows[windows.length - 1]!.usedPriorExperience).toBe(true);
    expect(windows[windows.length - 1]!.experienceCoverageThrough).not.toBeNull();
  });

  it("the overall scorecard aggregates exactly the per-window decisions", () => {
    const windowDecisions = result.report.windows.reduce((sum, w) => sum + w.decisionsCount, 0);
    const windowScored = result.report.windows.reduce((sum, w) => sum + w.scoredStances, 0);
    expect(result.report.overall.decisionsCount).toBe(windowDecisions);
    expect(result.report.overall.scoredStances).toBe(windowScored);
    expect(result.report.overall.decisionsCount).toBe(result.scored.length);
  });

  it("every scored decision stays read-only (non-executable, review-required)", () => {
    for (const decision of result.scored) {
      expect(decision.executable).toBe(false);
      expect(decision.reviewRequired).toBe(true);
    }
  });

  it("is deterministic — a fresh run yields an identical report", async () => {
    const again = await run();
    expect(again.report).toEqual(result.report);
  });
});
