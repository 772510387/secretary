import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { proposeRuleChangesFromExperience } from "../../src/app/index.js";
import { RuleProposalMemoryStore } from "../../src/infrastructure/storage/index.js";
import {
  softExperienceReportSchema,
  type ExperienceVerdict,
  type ReplayBias,
  type SoftExperienceReport,
  type SoftLesson,
} from "../../src/domain/decision/index.js";

function lesson(
  verdict: ExperienceVerdict,
  sampleSize: number,
  regime: SoftLesson["regime"] = { trend: "uptrend", rangeBucket: "mid", bias: "increase" },
): SoftLesson {
  const hits = verdict === "favorable" ? sampleSize : 0;
  return {
    regime,
    sampleSize,
    hits,
    hitRate: sampleSize > 0 ? hits / sampleSize : null,
    avgForwardReturn: 0.02,
    verdict,
    advice: "测试经验",
  };
}

function reportWith(lessons: SoftLesson[]): SoftExperienceReport {
  return softExperienceReportSchema.parse({
    schemaVersion: 1,
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    horizonTradingDays: 1,
    returnThreshold: 0,
    decisionsAnalyzed: 50,
    scoredStances: lessons.reduce((sum, item) => sum + item.sampleSize, 0),
    coverageThroughDate: "2026-06-30",
    advisoryOnly: true,
    generatedBy: "soft-experience-distiller",
    lessons,
  });
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("proposeRuleChangesFromExperience", () => {
  it("proposes for a favorable regime with enough samples (strengthen)", () => {
    const proposals = proposeRuleChangesFromExperience({ report: reportWith([lesson("favorable", 10)]) });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.observedVerdict).toBe("favorable");
    expect(proposals[0]!.recommendation).toContain("强化");
    expect(proposals[0]!.proposalId).toBe("ruleprop-uptrend-mid-increase");
  });

  it("proposes for an unfavorable regime with enough samples (weaken/remove)", () => {
    const proposals = proposeRuleChangesFromExperience({
      report: reportWith([lesson("unfavorable", 12, { trend: "uptrend", rangeBucket: "near_high", bias: "reduce" })]),
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.observedVerdict).toBe("unfavorable");
    expect(proposals[0]!.recommendation).toContain("弱化");
  });

  it("does NOT propose below the sample threshold, or for mixed/insufficient verdicts", () => {
    expect(proposeRuleChangesFromExperience({ report: reportWith([lesson("favorable", 5)]) })).toHaveLength(0);
    expect(proposeRuleChangesFromExperience({ report: reportWith([lesson("mixed", 20)]) })).toHaveLength(0);
    expect(proposeRuleChangesFromExperience({ report: reportWith([lesson("insufficient", 20)]) })).toHaveLength(0);
  });

  it("SAFETY: every proposal is review-required and never auto-applied", () => {
    const proposals = proposeRuleChangesFromExperience({
      report: reportWith([
        lesson("favorable", 10),
        lesson("unfavorable", 10, { trend: "downtrend", rangeBucket: "low", bias: "reduce" }),
      ]),
    });
    expect(proposals).toHaveLength(2);
    for (const proposal of proposals) {
      expect(proposal.status).toBe("pending_human_review");
      expect(proposal.autoApply).toBe(false);
      expect(proposal.requiresHumanApproval).toBe(true);
      expect(proposal.generatedBy).toBe("experience-rule-proposer");
    }
  });

  it("persists a proposal with an audit event flagged autoApply:false", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rule-proposal-"));
    tmpDirs.push(dir);
    const proposal = proposeRuleChangesFromExperience({ report: reportWith([lesson("favorable", 10)]) })[0]!;
    const result = new RuleProposalMemoryStore({ memoryDir: dir }).writeProposal(proposal);

    expect(existsSync(result.filePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(result.filePath, "utf8"));
    expect(persisted.autoApply).toBe(false);
    expect(persisted.status).toBe("pending_human_review");

    const logsDir = path.join(dir, "logs");
    let auditFound = false;
    for (const file of readdirSync(logsDir).filter((name) => name.endsWith(".jsonl"))) {
      for (const line of readFileSync(path.join(logsDir, file), "utf8").trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        if (event.actor.id === "rule-proposal-store") {
          auditFound = true;
          expect(event.action).toBe("suggest");
          expect(event.metadata.autoApply).toBe(false);
          expect(event.metadata.requiresHumanApproval).toBe(true);
        }
      }
    }
    expect(auditFound).toBe(true);
  });
});
