import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ruleChangeProposalSchema,
  softExperienceReportSchema,
  type RuleChangeProposal,
  type SoftExperienceReport,
} from "../domain/decision/index.js";
import { isExperienceUsableAt } from "./distill-experience.js";
import { searchModelMemory } from "./model-memory.js";

export interface LoadKnowledgeForWakeInput {
  memoryDir: string;
  asOfDate: string;
  maxItems?: number;
  /**
   * MEM-07: when given (e.g. today's holding names + top theme), the reback first pulls the
   * MOST RELEVANT past lessons via the MemoryRegistry keyword search (fenced to strictly before
   * asOfDate), then falls back to newest-first. Empty/absent → pure newest-first (legacy).
   */
  relevanceQuery?: string;
}

export interface WakeKnowledgeDigest {
  lessons: string[];
  ruleReminders: string[];
  asText: () => string;
}

const DEFAULT_MAX_ITEMS = 5;
/** Keep the morning prompt prefix tight — a few hundred chars, not an essay. */
const MAX_TEXT_LENGTH = 600;

/**
 * The morning read-back of the "记忆" organ (08:15/08:30 wake): surface the lessons the
 * brain should carry into today's decisions.
 *
 * Best-effort and synchronous: a missing dir, a corrupt file, or a malformed report is
 * swallowed — the wake routine must never fail because memory was empty or imperfect.
 *
 * STRICT TEMPORAL FENCE: an experience report may inform `asOfDate` only if all of its
 * knowledge was observable strictly before then (isExperienceUsableAt). This stops a
 * window's own lessons from "informing" its own past — the same aggregate-look-ahead
 * guard the backtester uses.
 */
export function loadKnowledgeForWake(input: LoadKnowledgeForWakeInput): WakeKnowledgeDigest {
  const memoryDir = path.resolve(input.memoryDir);
  const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;

  const lessons = collectLessons(memoryDir, input.asOfDate, maxItems, input.relevanceQuery);
  const ruleReminders = collectRuleReminders(memoryDir, maxItems);

  return {
    lessons,
    ruleReminders,
    asText: () => renderDigest(lessons, ruleReminders),
  };
}

/**
 * Lessons come from two sources, newest-first: the human-readable long-term files
 * (`long_term/<YYYY-MM>/<date>.md`, dated strictly before asOfDate) and the structured
 * experience reports that clear the temporal fence. Long-term files are dated by their
 * own filename, so a same-day or future file is excluded by date comparison.
 */
function collectLessons(
  memoryDir: string,
  asOfDate: string,
  maxItems: number,
  relevanceQuery?: string,
): string[] {
  const lessons: string[] = [];
  const seen = new Set<string>();
  const add = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      return lessons.length >= maxItems;
    }
    seen.add(trimmed);
    lessons.push(trimmed);
    return lessons.length >= maxItems;
  };

  // MEM-07: relevance-ranked lessons first (registry keyword search, fenced before asOfDate).
  for (const line of searchRelevantLessons(memoryDir, asOfDate, relevanceQuery, maxItems)) {
    if (add(line)) {
      return lessons;
    }
  }

  for (const line of readLongTermLessonLines(memoryDir, asOfDate)) {
    if (add(line)) {
      return lessons;
    }
  }

  for (const report of readUsableExperienceReports(memoryDir, asOfDate)) {
    for (const lesson of report.lessons) {
      if (add(lesson.advice)) {
        return lessons;
      }
    }
  }

  return lessons;
}

/**
 * MEM-07 consumer (reback): use the MemoryRegistry to surface the lessons most RELEVANT to
 * the query (today's holdings/themes), strictly fenced to before asOfDate. Best-effort —
 * any failure (empty query, no registry data) yields [] and the caller falls back to recent.
 */
function searchRelevantLessons(
  memoryDir: string,
  asOfDate: string,
  relevanceQuery: string | undefined,
  maxItems: number,
): string[] {
  const query = relevanceQuery?.trim();
  if (!query) {
    return [];
  }
  // Tokenized keyword search (so multi-name queries hit), fenced to before asOfDate.
  return searchModelMemory({
    memoryDir,
    query: query.slice(0, 120),
    categories: ["long_term", "daily_logs"],
    to: `${asOfDate}T00:00:00.000Z`,
    limit: maxItems,
  }).hits
    .map((hit) => hit.snippet.trim())
    .filter(Boolean);
}

/**
 * Read long-term digest files dated strictly before asOfDate, newest day first, and
 * pull out their bullet lines. The directory layout (long_term/<YYYY-MM>/<date>.md) is
 * the format distillDailyKnowledge writes.
 */
function readLongTermLessonLines(memoryDir: string, asOfDate: string): string[] {
  const longTermDir = path.join(memoryDir, "long_term");
  if (!existsSync(longTermDir)) {
    return [];
  }

  const files: { date: string; filePath: string }[] = [];
  for (const monthDir of safeReaddir(longTermDir)) {
    const monthPath = path.join(longTermDir, monthDir);
    for (const file of safeReaddir(monthPath)) {
      if (!file.endsWith(".md")) {
        continue;
      }
      const date = file.slice(0, -3); // strip ".md" → YYYY-MM-DD
      // Strict fence: a file dated on/after asOfDate describes today or the future and
      // must not inform today's wake.
      if (date < asOfDate) {
        files.push({ date, filePath: path.join(monthPath, file) });
      }
    }
  }

  files.sort((left, right) => right.date.localeCompare(left.date));

  const lines: string[] = [];
  for (const { filePath } of files) {
    try {
      for (const raw of readFileSync(filePath, "utf8").split("\n")) {
        const trimmed = raw.trim();
        if (trimmed.startsWith("- ")) {
          lines.push(trimmed.slice(2).trim());
        }
      }
    } catch {
      // Skip an unreadable file; the rest of long-term memory still informs the wake.
    }
  }
  return lines;
}

/** Experience reports that clear the strict temporal fence, newest coverage first. */
function readUsableExperienceReports(memoryDir: string, asOfDate: string): SoftExperienceReport[] {
  const experienceDir = path.join(memoryDir, "experience");
  if (!existsSync(experienceDir)) {
    return [];
  }

  const reports: SoftExperienceReport[] = [];
  for (const file of safeReaddir(experienceDir)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const report = softExperienceReportSchema.parse(
        JSON.parse(readFileSync(path.join(experienceDir, file), "utf8")),
      );
      if (isExperienceUsableAt(report, asOfDate)) {
        reports.push(report);
      }
    } catch {
      // Skip a malformed report; never let it abort the wake read-back.
    }
  }

  return reports.sort((left, right) =>
    (right.coverageThroughDate ?? "").localeCompare(left.coverageThroughDate ?? ""),
  );
}

/**
 * Active rule reminders = the pending rule PROPOSALS. They are reminders only — the
 * morning prompt is told a human must review them; they NEVER act as enforced rules.
 */
function collectRuleReminders(memoryDir: string, maxItems: number): string[] {
  const proposalsDir = path.join(memoryDir, "rule-proposals");
  if (!existsSync(proposalsDir)) {
    return [];
  }

  const reminders: string[] = [];
  for (const file of safeReaddir(proposalsDir).sort()) {
    if (!file.endsWith(".json")) {
      continue;
    }
    let proposal: RuleChangeProposal;
    try {
      proposal = ruleChangeProposalSchema.parse(
        JSON.parse(readFileSync(path.join(proposalsDir, file), "utf8")),
      );
    } catch {
      continue;
    }
    // Only still-open suggestions are worth reminding about.
    if (proposal.status === "pending_human_review") {
      reminders.push(proposal.recommendation);
      if (reminders.length >= maxItems) {
        break;
      }
    }
  }
  return reminders;
}

/**
 * Render a short Chinese block to prepend to the wake prompt. Capped to a few hundred
 * chars so it primes the brain without crowding out the day's fresh context. Empty
 * inputs render to "" so callers can prepend unconditionally.
 */
function renderDigest(lessons: string[], ruleReminders: string[]): string {
  const sections: string[] = [];
  if (lessons.length > 0) {
    sections.push(["【过往血泪教训】", ...lessons.map((item) => `- ${item}`)].join("\n"));
  }
  if (ruleReminders.length > 0) {
    sections.push(
      ["【待审规则提议（仅提醒，绝不自动生效）】", ...ruleReminders.map((item) => `- ${item}`)].join(
        "\n",
      ),
    );
  }
  if (sections.length === 0) {
    return "";
  }

  const text = sections.join("\n\n");
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…` : text;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
