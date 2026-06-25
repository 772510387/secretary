import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadKnowledgeForWake } from "../../src/app/load-knowledge-for-wake.js";
import { ExperienceMemoryStore } from "../../src/infrastructure/storage/experience-memory.js";
import { RuleProposalMemoryStore } from "../../src/infrastructure/storage/rule-proposal-memory.js";
import {
  ruleChangeProposalSchema,
  softExperienceReportSchema,
  type RuleChangeProposal,
  type SoftExperienceReport,
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "load-wake-"));
  tmpDirs.push(dir);
  return dir;
}

/** Write a long-term digest file the way distillDailyKnowledge would lay it out. */
function seedLongTerm(memoryDir: string, date: string, bullets: string[]): void {
  const dir = path.join(memoryDir, "long_term", date.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  const body = [`## 复盘 ${date}`, "", ...bullets.map((line) => `- ${line}`), ""].join("\n");
  writeFileSync(path.join(dir, `${date}.md`), body, "utf8");
}

function experienceReport(coverageThroughDate: string): SoftExperienceReport {
  return softExperienceReportSchema.parse({
    schemaVersion: 1,
    startDate: "2026-06-15",
    endDate: coverageThroughDate,
    horizonTradingDays: 1,
    returnThreshold: 0,
    decisionsAnalyzed: 10,
    scoredStances: 3,
    coverageThroughDate,
    advisoryOnly: true,
    generatedBy: "soft-experience-distiller",
    lessons: [
      {
        regime: { trend: "uptrend", rangeBucket: "mid", bias: "increase" },
        sampleSize: 3,
        hits: 3,
        hitRate: 1,
        avgForwardReturn: 0.04,
        verdict: "favorable",
        advice: "经验报告教训：上涨中位加配较可靠。",
      },
    ],
  });
}

function pendingProposal(): RuleChangeProposal {
  return ruleChangeProposalSchema.parse({
    schemaVersion: 1,
    proposalId: "ruleprop-uptrend-mid-increase",
    regime: { trend: "uptrend", rangeBucket: "mid", bias: "increase" },
    observedVerdict: "favorable",
    sampleSize: 10,
    hitRate: 0.9,
    avgForwardReturn: 0.04,
    recommendation: "复核并考虑强化加配倾向（需人工审核，绝不自动生效）",
    sourceStart: "2026-06-01",
    sourceEnd: "2026-06-18",
    status: "pending_human_review",
    autoApply: false,
    requiresHumanApproval: true,
    generatedBy: "experience-rule-proposer",
  });
}

describe("loadKnowledgeForWake", () => {
  it("returns an empty digest on empty memory (never throws)", () => {
    const memoryDir = tmpMemoryDir();
    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23" });
    expect(digest.lessons).toEqual([]);
    expect(digest.ruleReminders).toEqual([]);
    expect(digest.asText()).toBe("");
  });

  it("reads back long-term lessons dated strictly before asOfDate", () => {
    const memoryDir = tmpMemoryDir();
    seedLongTerm(memoryDir, "2026-06-19", ["上涨中位加配命中率高。"]);

    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23" });
    expect(digest.lessons).toContain("上涨中位加配命中率高。");
    expect(digest.asText()).toContain("【过往血泪教训】");
    expect(digest.asText()).toContain("上涨中位加配命中率高。");
  });

  it("respects the asOfDate fence for long-term files (same-day and future excluded)", () => {
    const memoryDir = tmpMemoryDir();
    seedLongTerm(memoryDir, "2026-06-23", ["今天自己的复盘，不能反哺今天。"]);
    seedLongTerm(memoryDir, "2026-06-25", ["未来的复盘，更不能反哺今天。"]);

    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23" });
    expect(digest.lessons).toEqual([]);
    expect(digest.asText()).toBe("");
  });

  it("biases lessons toward the relevanceQuery via the registry (MEM-07)", () => {
    const memoryDir = tmpMemoryDir();
    // asOfDate in the future so freshly-written files pass the registry's mtime fence.
    seedLongTerm(memoryDir, "2030-01-02", ["大盘跳水时优先买银行股护盘。"]);
    seedLongTerm(memoryDir, "2030-01-03", ["半导体题材轮动，关注设备龙头。"]);

    const digest = loadKnowledgeForWake({
      memoryDir,
      asOfDate: "2099-01-01",
      relevanceQuery: "大盘跳水 银行股",
    });
    // The relevant lesson is surfaced (registry keyword search), ranked ahead of the rest.
    expect(digest.lessons.some((line) => line.includes("银行股"))).toBe(true);
    expect(digest.lessons[0]).toContain("银行股");
  });

  it("respects the strict temporal fence for experience reports", () => {
    const memoryDir = tmpMemoryDir();
    const store = new ExperienceMemoryStore({ memoryDir });
    // coverageThroughDate must be STRICTLY before asOfDate to be usable.
    store.writeReport(experienceReport("2026-06-20")); // usable at 2026-06-23
    store.writeReport(experienceReport("2026-06-23")); // NOT usable at 2026-06-23 (not strictly before)

    const usable = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23" });
    expect(usable.lessons.some((line) => line.includes("经验报告教训"))).toBe(true);

    // On the coverage date itself, the report is fenced out entirely.
    const fenced = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-20" });
    expect(fenced.lessons.some((line) => line.includes("经验报告教训"))).toBe(false);
  });

  it("surfaces pending rule proposals as review-only reminders", () => {
    const memoryDir = tmpMemoryDir();
    new RuleProposalMemoryStore({ memoryDir }).writeProposal(pendingProposal());

    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23" });
    expect(digest.ruleReminders.length).toBe(1);
    expect(digest.ruleReminders[0]).toContain("需人工审核");
    expect(digest.asText()).toContain("仅提醒，绝不自动生效");
  });

  it("caps the rendered text to a few hundred chars", () => {
    const memoryDir = tmpMemoryDir();
    const longBullets = Array.from({ length: 20 }, (_, index) => `第 ${index} 条很长很长很长很长很长很长的教训。`);
    seedLongTerm(memoryDir, "2026-06-19", longBullets);

    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23", maxItems: 20 });
    expect(digest.asText().length).toBeLessThanOrEqual(600);
  });

  it("honours maxItems", () => {
    const memoryDir = tmpMemoryDir();
    seedLongTerm(memoryDir, "2026-06-19", ["教训一", "教训二", "教训三", "教训四"]);

    const digest = loadKnowledgeForWake({ memoryDir, asOfDate: "2026-06-23", maxItems: 2 });
    expect(digest.lessons).toHaveLength(2);
  });
});
