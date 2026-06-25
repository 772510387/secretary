import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReplay } from "../../src/runtime/index.js";
import {
  ForwardOutcomeReader,
  distillSoftExperience,
  scoreReplaySnapshots,
} from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import { ExperienceMemoryStore } from "../../src/infrastructure/storage/index.js";
import { FIXED_CEREBELLUM_ALARM_RULES } from "../../src/domain/cerebellum/index.js";
import { pointInTimeSnapshotSchema } from "../../src/domain/portfolio/index.js";
import type { SoftExperienceReport } from "../../src/domain/decision/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

const SUBSET_IDS = new Set(["pre-market-plan", "closing-snapshot", "post-close-review"]);
const SUBSET_ALARMS = FIXED_CEREBELLUM_ALARM_RULES.filter((rule) => SUBSET_IDS.has(rule.alarmId));

let tmpDir: string;
let report: SoftExperienceReport;
let writePath: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "replay-experience-"));

  const replayReport = await runReplay({
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
  const snapshots = replayReport.snapshots.map((record) =>
    pointInTimeSnapshotSchema.parse(JSON.parse(readFileSync(record.filePath, "utf8"))),
  );

  const scored = await scoreReplaySnapshots({
    snapshots,
    forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(replayBarsBySymbol())),
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    horizonTradingDays: 1,
    returnThreshold: 0,
  });

  report = distillSoftExperience({
    scored: scored.scored,
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    horizonTradingDays: 1,
    returnThreshold: 0,
    minSamples: 3,
  });

  let counter = 0;
  writePath = new ExperienceMemoryStore({
    memoryDir: tmpDir,
    idGenerator: () => `evt-${(counter += 1)}`,
  }).writeReport(report).filePath;
});

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("replay soft-experience distillation", () => {
  it("learns that 'trim near the 60-day high' loses on a pure uptrend (unfavorable)", () => {
    // All 6 reduce stances fall into one regime; price kept rising -> 0 hits.
    const lesson = report.lessons.find(
      (item) =>
        item.regime.trend === "uptrend" &&
        item.regime.rangeBucket === "near_high" &&
        item.regime.bias === "reduce",
    );
    expect(lesson).toBeDefined();
    expect(lesson!.sampleSize).toBe(6);
    expect(lesson!.hitRate).toBe(0);
    expect(lesson!.verdict).toBe("unfavorable");
    expect(report.scoredStances).toBe(6);
  });

  it("is advisory only and persisted under memory/experience", () => {
    expect(report.advisoryOnly).toBe(true);
    expect(existsSync(writePath)).toBe(true);
    expect(writePath.replace(/\\/g, "/")).toContain("/experience/");

    const persisted = JSON.parse(readFileSync(writePath, "utf8"));
    expect(persisted.advisoryOnly).toBe(true);
    expect(persisted).toEqual(report);
  });

  it("records the soft-experience write in an audit log flagged not-a-hard-rule", () => {
    const logsDir = path.join(tmpDir, "logs");
    let found = false;
    for (const date of ["2026-06-18", "2026-06-19", new Date().toISOString().slice(0, 10)]) {
      const auditPath = path.join(logsDir, `audit-${date}.jsonl`);
      if (!existsSync(auditPath)) {
        continue;
      }
      for (const line of readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.actor.id === "experience-memory-store") {
          found = true;
          expect(event.metadata.isHardRule).toBe(false);
          expect(event.metadata.advisoryOnly).toBe(true);
        }
      }
    }
    expect(found).toBe(true);
  });
});
