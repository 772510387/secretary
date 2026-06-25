import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { distillDailyKnowledge } from "../../src/app/distill-daily-knowledge.js";
import { DecisionMemoryStore } from "../../src/infrastructure/storage/decision-memory.js";
import {
  scoredDecisionSchema,
  type ReplayBias,
  type ScoredDecision,
  type ScoredStance,
} from "../../src/domain/decision/index.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function tmpMemoryDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "distill-daily-"));
  tmpDirs.push(dir);
  return dir;
}

interface StanceSpec {
  symbol: string;
  bias: ReplayBias;
  rangePosition60: number;
  forwardReturn: number;
  correct: boolean;
}

function realizedStance(spec: StanceSpec): ScoredStance {
  return {
    symbol: spec.symbol,
    market: "SZSE",
    name: "标的",
    bias: spec.bias,
    confidence: 0.5,
    rationale: "测试",
    basis: {
      trend: "uptrend",
      technicalAsOfDate: "2026-06-19",
      rangePosition60: spec.rangePosition60,
      closeVsMa20: null,
    },
    forwardOutcome: {
      horizonTradingDays: 1,
      fromDate: "2026-06-18",
      fromClose: 10,
      realized: true,
      toDate: "2026-06-19",
      toClose: Math.round(10 * (1 + spec.forwardReturn) * 100) / 100,
      forwardReturn: spec.forwardReturn,
    },
    correct: spec.correct,
  };
}

function scoredDecision(decisionId: string, asOfDate: string, stances: ScoredStance[]): ScoredDecision {
  const hits = stances.filter((stance) => stance.correct === true).length;
  return scoredDecisionSchema.parse({
    schemaVersion: 1,
    decisionId,
    snapshotId: `snap-${decisionId}`,
    accountId: "paper-replay",
    alarmId: "closing-snapshot",
    asOfDate,
    asOfTime: `${asOfDate}T07:30:00.000Z`,
    horizonTradingDays: 1,
    returnThreshold: 0,
    stances,
    summary: {
      scoredCount: stances.length,
      hitCount: hits,
      hitRate: stances.length > 0 ? hits / stances.length : null,
      avgForwardReturn: 0,
    },
    executable: false,
    reviewRequired: true,
    generatedBy: "deterministic-replay-decider",
    scoredBy: "forward-return-scorer",
  });
}

function seedDecision(memoryDir: string, decision: ScoredDecision): void {
  new DecisionMemoryStore({ memoryDir }).writeDecision(decision);
}

describe("distillDailyKnowledge", () => {
  it("writes a long_term file and returns counts for a day with lessons", async () => {
    const memoryDir = tmpMemoryDir();
    seedDecision(
      memoryDir,
      scoredDecision("dec-1", "2026-06-19", [
        realizedStance({ symbol: "000001", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.05, correct: true }),
        realizedStance({ symbol: "000002", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.04, correct: true }),
        realizedStance({ symbol: "000003", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.03, correct: true }),
      ]),
    );

    const result = await distillDailyKnowledge({
      memoryDir,
      tradingDate: "2026-06-19",
      now: "2026-06-19T12:30:00.000Z",
    });

    expect(result.degraded).toBe(false);
    expect(result.lessonsWritten).toBeGreaterThan(0);
    expect(result.longTermPath).toBeDefined();

    const expectedPath = path.join(memoryDir, "long_term", "2026-06", "2026-06-19.md");
    expect(result.longTermPath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);

    const body = readFileSync(expectedPath, "utf8");
    expect(body).toContain("复盘 2026-06-19");
    expect(body).toContain("软提示"); // advisory framing, not a hard rule
  });

  it("returns degraded:true (no throw) for a day with no data", async () => {
    const memoryDir = tmpMemoryDir();
    const result = await distillDailyKnowledge({ memoryDir, tradingDate: "2026-06-19" });
    expect(result).toEqual({ lessonsWritten: 0, ruleProposalsCreated: 0, degraded: true });
    expect(existsSync(path.join(memoryDir, "long_term"))).toBe(false);
  });

  it("appends a second section when re-run for the same day (never clobbers)", async () => {
    const memoryDir = tmpMemoryDir();
    seedDecision(
      memoryDir,
      scoredDecision("dec-1", "2026-06-19", [
        realizedStance({ symbol: "000001", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.05, correct: true }),
        realizedStance({ symbol: "000002", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.04, correct: true }),
        realizedStance({ symbol: "000003", bias: "increase", rangePosition60: 0.5, forwardReturn: 0.03, correct: true }),
      ]),
    );

    await distillDailyKnowledge({ memoryDir, tradingDate: "2026-06-19", now: "2026-06-19T12:30:00.000Z" });
    await distillDailyKnowledge({ memoryDir, tradingDate: "2026-06-19", now: "2026-06-19T13:30:00.000Z" });

    const body = readFileSync(path.join(memoryDir, "long_term", "2026-06", "2026-06-19.md"), "utf8");
    expect(body.match(/## 复盘 2026-06-19/g)?.length).toBe(2);
  });

  it("creates a review-required PROPOSAL (never an applied rule) for a strong regime", async () => {
    const memoryDir = tmpMemoryDir();
    // 8+ samples in a single favorable regime → above the proposal threshold.
    const stances: ScoredStance[] = [];
    for (let index = 0; index < 9; index += 1) {
      stances.push(
        realizedStance({
          symbol: `00000${index}`,
          bias: "increase",
          rangePosition60: 0.5,
          forwardReturn: 0.05,
          correct: true,
        }),
      );
    }
    seedDecision(memoryDir, scoredDecision("dec-1", "2026-06-19", stances));

    const result = await distillDailyKnowledge({
      memoryDir,
      tradingDate: "2026-06-19",
      now: "2026-06-19T12:30:00.000Z",
    });

    expect(result.ruleProposalsCreated).toBeGreaterThan(0);

    const proposalsDir = path.join(memoryDir, "rule-proposals");
    const files = readdirSync(proposalsDir).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    const proposal = JSON.parse(readFileSync(path.join(proposalsDir, files[0]!), "utf8"));
    expect(proposal.status).toBe("pending_human_review");
    expect(proposal.autoApply).toBe(false);
    expect(proposal.requiresHumanApproval).toBe(true);

    // HARD RED LINE: nothing was written to any hard-rule store.
    expect(existsSync(path.join(memoryDir, "rules"))).toBe(false);
  });

  it("degrades when the day's stances are all unrealized (nothing to remember)", async () => {
    const memoryDir = tmpMemoryDir();
    const unrealized = scoredDecisionSchema.parse({
      schemaVersion: 1,
      decisionId: "dec-1",
      snapshotId: "snap-1",
      accountId: "paper-replay",
      alarmId: "closing-snapshot",
      asOfDate: "2026-06-19",
      asOfTime: "2026-06-19T07:30:00.000Z",
      horizonTradingDays: 1,
      returnThreshold: 0,
      stances: [
        {
          symbol: "000001",
          market: "SZSE",
          name: "标的",
          bias: "hold",
          confidence: 0.5,
          rationale: "测试",
          basis: { trend: "uptrend", technicalAsOfDate: "2026-06-19", rangePosition60: 0.5, closeVsMa20: null },
          forwardOutcome: {
            horizonTradingDays: 1,
            fromDate: null,
            fromClose: null,
            realized: false,
            toDate: null,
            toClose: null,
            forwardReturn: null,
          },
          correct: null,
        },
      ],
      summary: { scoredCount: 0, hitCount: 0, hitRate: null, avgForwardReturn: null },
      executable: false,
      reviewRequired: true,
      generatedBy: "deterministic-replay-decider",
      scoredBy: "forward-return-scorer",
    });
    seedDecision(memoryDir, unrealized);

    const result = await distillDailyKnowledge({ memoryDir, tradingDate: "2026-06-19" });
    expect(result.degraded).toBe(true);
    expect(result.lessonsWritten).toBe(0);
  });
});
