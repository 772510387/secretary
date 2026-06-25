import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { z } from "zod";
import {
  scoredDecisionSchema,
  softExperienceReportSchema,
  type ScoredDecision,
  type SoftExperienceReport,
  type SoftLesson,
} from "../domain/decision/index.js";
import { brainInputSchema, type BrainProvider } from "../domain/brain/index.js";
import { AtomicFileWriter } from "../infrastructure/storage/atomic-file-writer.js";
import { RuleProposalMemoryStore } from "../infrastructure/storage/rule-proposal-memory.js";
import { distillSoftExperience } from "./distill-experience.js";
import { proposeRuleChangesFromExperience } from "./propose-rules.js";

export interface DistillDailyKnowledgeInput {
  memoryDir: string;
  tradingDate: string;
  now?: string;
}

export interface DistillDailyKnowledgeDeps {
  brainProvider?: BrainProvider;
}

export interface DistillDailyKnowledgeResult {
  lessonsWritten: number;
  ruleProposalsCreated: number;
  longTermPath?: string;
  degraded: boolean;
}

export class DistillDailyKnowledgeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DistillDailyKnowledgeError";
  }
}

/**
 * The evening roll-up of the "记忆" organ: read the day's scored decisions, distill
 * them into soft lessons (reusing distillSoftExperience), append a human-readable
 * digest to long-term memory, and — only when a regime is consistently good/bad —
 * draft review-required rule PROPOSALS.
 *
 * HARD RED LINE: nothing here ever writes or mutates a hard rule. The single soft→hard
 * bridge is proposeRuleChangesFromExperience, whose every output is inert
 * (pending_human_review / autoApply:false). Soft lessons persist freely; rule changes
 * are only ever suggestions for a human to review.
 *
 * Deterministic-first: the digest is built from the deterministic distillation. An
 * optional brain only polishes the prose — if it is absent or fails, we degrade to the
 * deterministic text rather than losing the lesson.
 */
export async function distillDailyKnowledge(
  input: DistillDailyKnowledgeInput,
  deps: DistillDailyKnowledgeDeps = {},
): Promise<DistillDailyKnowledgeResult> {
  const memoryDir = path.resolve(input.memoryDir);
  const scored = readScoredDecisionsForDate(memoryDir, input.tradingDate);

  // No data for the day is a normal, expected state (a holiday, a daemon that did not
  // run): degrade quietly rather than throwing, so the nightly job never crashes the
  // scheduler on an empty day.
  if (scored.length === 0) {
    return { lessonsWritten: 0, ruleProposalsCreated: 0, degraded: true };
  }

  let report: SoftExperienceReport;
  try {
    report = distillSoftExperience({
      scored,
      startDate: input.tradingDate,
      endDate: input.tradingDate,
      // A single day's scored decisions already carry their own forward horizon /
      // return threshold; mirror the first decision so the report stays consistent
      // with how the decisions were scored.
      horizonTradingDays: scored[0]!.horizonTradingDays,
      returnThreshold: scored[0]!.returnThreshold,
    });
  } catch (error) {
    throw new DistillDailyKnowledgeError(
      `Failed to distill soft experience for ${input.tradingDate}`,
      { cause: error },
    );
  }

  // A day whose stances were all unrealized (degraded / no as-of close) yields no
  // lessons — there is nothing to remember, so degrade rather than write an empty file.
  if (report.lessons.length === 0) {
    return { lessonsWritten: 0, ruleProposalsCreated: 0, degraded: true };
  }

  const digest = await buildDigest(report, input.tradingDate, deps.brainProvider);
  const longTermPath = appendLongTermDigest(memoryDir, input.tradingDate, digest, input.now);

  const ruleProposalsCreated = persistRuleProposals(memoryDir, report, input.now);

  return {
    lessonsWritten: report.lessons.length,
    ruleProposalsCreated,
    longTermPath,
    // The brain is optional polish; if it was requested but unavailable we still wrote
    // the deterministic digest, so the day was NOT degraded.
    degraded: false,
  };
}

/** Long-term file path: `<memoryDir>/long_term/<YYYY-MM>/<tradingDate>.md`. */
export function createLongTermPath(memoryDir: string, tradingDate: string): string {
  const yearMonth = tradingDate.slice(0, 7); // YYYY-MM
  return path.join(path.resolve(memoryDir), "long_term", yearMonth, `${tradingDate}.md`);
}

/**
 * Read every scored decision filed under `decisions/<tradingDate>/`. Each is validated
 * through the canonical schema (the trust boundary), and an unreadable file is skipped
 * rather than aborting the whole roll-up — a single corrupt artifact must not cost the
 * day its other lessons.
 */
function readScoredDecisionsForDate(memoryDir: string, tradingDate: string): ScoredDecision[] {
  const dateDir = path.join(memoryDir, "decisions", tradingDate);
  if (!existsSync(dateDir)) {
    return [];
  }

  const schema = scoredDecisionSchema as z.ZodType<ScoredDecision>;
  const decisions: ScoredDecision[] = [];
  for (const entry of readdirSync(dateDir).sort()) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      decisions.push(schema.parse(JSON.parse(readFileSync(path.join(dateDir, entry), "utf8"))));
    } catch {
      // Skip an unreadable / non-conforming artifact; the rest of the day still counts.
    }
  }
  return decisions;
}

/**
 * Append (never overwrite) the day's digest to long-term memory. AtomicFileWriter
 * always writes the full file, so we read any prior content first and concatenate —
 * re-running the roll-up for a day stacks a fresh, timestamped section beneath the old
 * one rather than clobbering it.
 */
function appendLongTermDigest(
  memoryDir: string,
  tradingDate: string,
  digest: string,
  now?: string,
): string {
  const longTermPath = createLongTermPath(memoryDir, tradingDate);
  const stamp = now ?? new Date().toISOString();
  const section = `## 复盘 ${tradingDate} (${stamp})\n\n${digest}\n`;

  let body = section;
  if (existsSync(longTermPath)) {
    const prior = readFileSync(longTermPath, "utf8").trimEnd();
    body = prior.length > 0 ? `${prior}\n\n${section}` : section;
  } else {
    body = `# 长期记忆 · ${tradingDate.slice(0, 7)}\n\n${section}`;
  }

  new AtomicFileWriter().write(longTermPath, body.endsWith("\n") ? body : `${body}\n`);
  return longTermPath;
}

/**
 * Build the lesson digest. Deterministic-first: the regime advice lines are the source
 * of truth. The optional brain only rewrites them into smoother prose; a missing or
 * failing brain falls back to the deterministic text so a lesson is never lost.
 */
async function buildDigest(
  report: SoftExperienceReport,
  tradingDate: string,
  brainProvider?: BrainProvider,
): Promise<string> {
  const deterministic = deterministicDigest(report);
  if (brainProvider === undefined) {
    return deterministic;
  }

  try {
    const output = await brainProvider.generate(
      brainInputSchema.parse({
        requestId: `distill-${tradingDate}`,
        // 盘后总结 is the closing review task; the digest is its written product.
        taskType: "closing_review",
        prompt:
          `把以下当日复盘的软经验，凝练成简洁的中文“血泪教训”要点（仅作软提示，绝不构成硬性交易规则）：\n\n${deterministic}`,
        context: { tradingDate, advisoryOnly: true },
      }),
    );
    const text = output.summary?.trim();
    return text && text.length > 0 ? text : deterministic;
  } catch {
    // Brain is optional polish — degrade to the deterministic digest, never drop it.
    return deterministic;
  }
}

function deterministicDigest(report: SoftExperienceReport): string {
  const header =
    `分析决策 ${report.decisionsAnalyzed} 条、已评分 ${report.scoredStances} 个判断；` +
    `经验仅作软提示，绝不自动改硬规则。`;
  const lines = report.lessons.map((lesson) => `- ${formatLesson(lesson)}`);
  return [header, "", ...lines].join("\n");
}

function formatLesson(lesson: SoftLesson): string {
  return lesson.advice;
}

/**
 * Persist any rule PROPOSALS the day's lessons warrant. Reuses the existing soft→hard
 * bridge (proposeRuleChangesFromExperience → RuleProposalMemoryStore): every result is
 * pending_human_review / autoApply:false. We deliberately do NOT touch any hard-rule
 * store here.
 */
function persistRuleProposals(
  memoryDir: string,
  report: SoftExperienceReport,
  now?: string,
): number {
  const proposals = proposeRuleChangesFromExperience({ report });
  if (proposals.length === 0) {
    return 0;
  }

  const fixedNow = now;
  const store = new RuleProposalMemoryStore({
    memoryDir,
    now: fixedNow ? () => new Date(fixedNow) : undefined,
  });
  for (const proposal of proposals) {
    store.writeProposal(proposal);
  }
  return proposals.length;
}
