import path from "node:path";
import type { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import {
  softExperienceReportSchema,
  type SoftExperienceReport,
} from "../../domain/decision/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface ExperienceMemoryPaths {
  experienceDir: string;
  logsDir: string;
  reportPath: string;
  auditLogPath: string;
}

export interface ExperienceMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ExperienceWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

/**
 * Persists soft-experience reports under `memory/experience/`. Mirrors the other
 * stores. The report is ADVISORY ONLY (a soft hint), never a hard rule — the audit
 * event records that explicitly.
 */
export class ExperienceMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: ExperienceMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeReport(report: SoftExperienceReport): ExperienceWriteResult {
    const occurredAt = this.isoNow();
    const paths = createExperienceMemoryPaths(
      this.memoryDir,
      report.startDate,
      report.endDate,
      occurredAt,
    );
    const store = new JsonStore<SoftExperienceReport>({
      filePath: paths.reportPath,
      schema: softExperienceReportSchema as z.ZodType<SoftExperienceReport>,
      writer: this.writer,
    });
    const result = store.write(report);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForExperience(report, {
        occurredAt,
        eventId: `audit-experience-${safeIdentifier(this.idGenerator())}`,
        reportPath: result.filePath,
        reportBackupPath: result.backupPath,
      }),
      this.writer,
    );

    return {
      filePath: result.filePath,
      backupPath: result.backupPath,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("ExperienceMemoryStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createExperienceMemoryPaths(
  memoryDir: string,
  startDate: string,
  endDate: string,
  occurredAt?: string,
): ExperienceMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const experienceDir = path.join(resolvedMemoryDir, "experience");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const auditDate = (occurredAt ?? startDate).slice(0, 10);

  return {
    experienceDir,
    logsDir,
    reportPath: path.join(experienceDir, `${safeFileName(`${startDate}_${endDate}`)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForExperience(
  report: SoftExperienceReport,
  options: {
    occurredAt: string;
    eventId: string;
    reportPath: string;
    reportBackupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: { type: "system", id: "experience-memory-store" },
    action: "write",
    subject: { type: "memory", id: `experience-${report.startDate}-${report.endDate}` },
    severity: "info",
    result: "success",
    message: `Soft-experience report ${report.startDate}..${report.endDate} written`,
    metadata: {
      startDate: report.startDate,
      endDate: report.endDate,
      horizonTradingDays: report.horizonTradingDays,
      decisionsAnalyzed: report.decisionsAnalyzed,
      scoredStances: report.scoredStances,
      lessonsCount: report.lessons.length,
      advisoryOnly: report.advisoryOnly,
      isHardRule: false,
      filePath: path.normalize(options.reportPath),
      backupPath: options.reportBackupPath ? path.normalize(options.reportBackupPath) : null,
      liveTrading: false,
    },
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "experience";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
