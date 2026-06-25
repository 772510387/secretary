import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { CerebellumAlarmType } from "../domain/cerebellum/index.js";
import type { JsonValue } from "../domain/shared/index.js";
import { AtomicFileWriter } from "../infrastructure/storage/atomic-file-writer.js";

export type PeriodReviewAlarmType = Extract<
  CerebellumAlarmType,
  "weekly_review" | "monthly_review" | "yearly_review"
>;

export interface PersistPeriodReviewInput {
  memoryDir: string;
  reviewType: PeriodReviewAlarmType;
  report: string;
  generatedAt: string;
  title?: string;
  metadata?: Record<string, JsonValue>;
}

export interface PersistPeriodReviewResult {
  path: string;
  appended: boolean;
}

export function persistPeriodReview(input: PersistPeriodReviewInput): PersistPeriodReviewResult {
  const generatedAt = normalizeIso(input.generatedAt);
  const filePath = createPeriodReviewPath(input.memoryDir, input.reviewType, generatedAt);
  const section = renderReviewSection(input, generatedAt);
  const prior = existsSync(filePath) ? readFileSync(filePath, "utf8").trimEnd() : "";
  const body = prior.length > 0 ? `${prior}\n\n${section}` : `${renderReviewHeader(input.reviewType, generatedAt)}\n\n${section}`;

  new AtomicFileWriter().write(filePath, body.endsWith("\n") ? body : `${body}\n`);
  return { path: filePath, appended: prior.length > 0 };
}

export function createPeriodReviewPath(
  memoryDir: string,
  reviewType: PeriodReviewAlarmType,
  generatedAt: string,
): string {
  const date = generatedAt.slice(0, 10);
  const year = date.slice(0, 4);
  const month = date.slice(0, 7);
  const root = path.resolve(memoryDir);

  switch (reviewType) {
    case "weekly_review":
      return path.join(root, "weekly_reviews", year, `${date}.md`);
    case "monthly_review":
      return path.join(root, "monthly_reviews", year, `${month}.md`);
    case "yearly_review":
      return path.join(root, "yearly_reviews", `${year}.md`);
  }
}

function renderReviewHeader(reviewType: PeriodReviewAlarmType, generatedAt: string): string {
  return `# ${reviewTitle(reviewType)} · ${generatedAt.slice(0, 10)}`;
}

function renderReviewSection(input: PersistPeriodReviewInput, generatedAt: string): string {
  const title = input.title?.trim() || reviewTitle(input.reviewType);
  const metadata = input.metadata ? `\n\n元数据：\n\n\`\`\`json\n${JSON.stringify(input.metadata, null, 2)}\n\`\`\`\n` : "";

  return [
    `## ${title} (${generatedAt})`,
    "",
    "安全边界：仅保存复盘文本和元数据；不写账户、不下单、不改规则。",
    metadata.trimEnd(),
    "正文：",
    "",
    redactSensitiveText(input.report.trim() || "本次复盘无正文。"),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function reviewTitle(reviewType: PeriodReviewAlarmType): string {
  switch (reviewType) {
    case "weekly_review":
      return "周复盘";
    case "monthly_review":
      return "月复盘";
    case "yearly_review":
      return "年复盘";
  }
}

function normalizeIso(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new PersistPeriodReviewError(`Invalid generatedAt: ${value}`);
  }

  return parsed.toISOString();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
}

export class PersistPeriodReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersistPeriodReviewError";
  }
}
