import { readFileSync } from "node:fs";
import {
  ForwardOutcomeReader,
  distillSoftExperience,
  isExperienceUsableAt,
  scoreReplaySnapshots,
  summarizeScoredDecisions,
  type ReplayDecider,
} from "../app/index.js";
import {
  pointInTimeSnapshotSchema,
  type Account,
  type PointInTimeSnapshot,
  type Position,
} from "../domain/portfolio/index.js";
import {
  walkForwardReportSchema,
  type DecisionGenerator,
  type ScoredDecision,
  type SoftExperienceReport,
  type WalkForwardReport,
  type WalkForwardWindow,
} from "../domain/decision/index.js";
import type { CerebellumAlarmRule } from "../domain/cerebellum/index.js";
import type { HistoryProvider } from "../infrastructure/providers/index.js";
import { runReplay } from "./replay-runner.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WalkForwardConfig {
  startDate: string;
  endDate: string;
  account: Account;
  positions: Position[];
  historyProvider: HistoryProvider;
  memoryDir: string;
  /** Calendar-day length of each walk-forward window. */
  windowDays: number;
  horizonTradingDays: number;
  returnThreshold: number;
  /**
   * Builds the decider for a window from the fenced prior-window experience. The
   * deterministic decider ignores it; the model decider uses it as an advisory hint.
   */
  makeDecider: (experience: SoftExperienceReport | undefined) => ReplayDecider;
  /** Which decider family ran (recorded on the report). */
  deciderKind: DecisionGenerator;
  alarms?: readonly CerebellumAlarmRule[];
  historyCount?: number;
  minSamples?: number;
}

export interface WalkForwardResult {
  report: WalkForwardReport;
  scored: ScoredDecision[];
}

interface SnapshotWindow {
  windowStart: string;
  windowEnd: string;
  snapshots: PointInTimeSnapshot[];
}

/**
 * Rolls the closed self-evolution loop forward across the date range, window by
 * window. For each window it distills soft experience from ALL prior windows' scored
 * decisions and hands it to the decider — but the per-snapshot temporal fence
 * (`isExperienceUsableAt`) ensures a decision only ever uses experience whose outcomes
 * fully realized before it. So a window's own future can never inform its past, and
 * early windows simply run without (yet-unrealized) experience. Read-only throughout.
 */
export async function runWalkForward(config: WalkForwardConfig): Promise<WalkForwardResult> {
  const replay = await runReplay({
    startDate: config.startDate,
    endDate: config.endDate,
    account: config.account,
    positions: config.positions,
    historyProvider: config.historyProvider,
    memoryDir: config.memoryDir,
    alarms: config.alarms,
    historyCount: config.historyCount,
    reason: "replay",
  });

  const snapshots = replay.snapshots
    .map((record) => pointInTimeSnapshotSchema.parse(JSON.parse(readFileSync(record.filePath, "utf8"))))
    .sort((left, right) => left.asOfTime.localeCompare(right.asOfTime));

  const windows = partitionByWindow(snapshots, config.startDate, config.windowDays);
  const forwardReader = new ForwardOutcomeReader(config.historyProvider);

  const pool: ScoredDecision[] = [];
  const allScored: ScoredDecision[] = [];
  const windowReports: WalkForwardWindow[] = [];

  for (const window of windows) {
    const experience =
      pool.length > 0
        ? distillSoftExperience({
            scored: pool,
            startDate: config.startDate,
            endDate: window.windowStart,
            horizonTradingDays: config.horizonTradingDays,
            returnThreshold: config.returnThreshold,
            minSamples: config.minSamples,
          })
        : undefined;

    const scored = await scoreReplaySnapshots({
      snapshots: window.snapshots,
      decider: config.makeDecider(experience),
      forwardReader,
      startDate: window.windowStart,
      endDate: window.windowEnd,
      horizonTradingDays: config.horizonTradingDays,
      returnThreshold: config.returnThreshold,
    });

    const maxAsOfDate = window.snapshots.reduce(
      (latest, snapshot) => (snapshot.asOfDate > latest ? snapshot.asOfDate : latest),
      window.windowStart,
    );
    windowReports.push({
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      decisionsCount: scored.scorecard.decisionsCount,
      scoredStances: scored.scorecard.scoredStances,
      hitRate: scored.scorecard.hitRate,
      avgForwardReturn: scored.scorecard.avgForwardReturn,
      usedPriorExperience: experience !== undefined && isExperienceUsableAt(experience, maxAsOfDate),
      experienceCoverageThrough: experience?.coverageThroughDate ?? null,
      experienceLessons: experience?.lessons.length ?? 0,
    });

    pool.push(...scored.scored);
    allScored.push(...scored.scored);
  }

  const overall = summarizeScoredDecisions(allScored, {
    startDate: config.startDate,
    endDate: config.endDate,
    horizonTradingDays: config.horizonTradingDays,
    returnThreshold: config.returnThreshold,
  });

  const report = walkForwardReportSchema.parse({
    schemaVersion: 1,
    startDate: config.startDate,
    endDate: config.endDate,
    windowDays: config.windowDays,
    horizonTradingDays: config.horizonTradingDays,
    returnThreshold: config.returnThreshold,
    decider: config.deciderKind,
    windowsCount: windowReports.length,
    windows: windowReports,
    overall,
    advisoryOnly: true,
  });

  return { report, scored: allScored };
}

function partitionByWindow(
  snapshots: PointInTimeSnapshot[],
  startDate: string,
  windowDays: number,
): SnapshotWindow[] {
  const startMs = Date.parse(`${startDate}T00:00:00.000Z`);
  const byIndex = new Map<number, PointInTimeSnapshot[]>();

  for (const snapshot of snapshots) {
    const ms = Date.parse(`${snapshot.asOfDate}T00:00:00.000Z`);
    const index = Math.floor((ms - startMs) / (windowDays * DAY_MS));
    const list = byIndex.get(index) ?? [];
    list.push(snapshot);
    byIndex.set(index, list);
  }

  return [...byIndex.keys()]
    .sort((left, right) => left - right)
    .map((index) => ({
      windowStart: dateOf(startMs + index * windowDays * DAY_MS),
      windowEnd: dateOf(startMs + (index + 1) * windowDays * DAY_MS - DAY_MS),
      snapshots: byIndex.get(index)!,
    }));
}

function dateOf(ms: number): string {
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
