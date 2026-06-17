import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  researchReportSchema,
  type ResearchReport,
} from "../../domain/research/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface ResearchMemoryPaths {
  researchDir: string;
  logsDir: string;
  tradingDateDir: string;
  reportPath: string;
  auditLogPath: string;
}

export interface ResearchMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ResearchReportWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

export class ResearchMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: ResearchMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeReport(report: ResearchReport): ResearchReportWriteResult {
    const occurredAt = this.isoNow();
    const paths = createResearchMemoryPaths(
      this.memoryDir,
      report.tradingDate,
      report.reportId,
      occurredAt,
    );
    const store = new JsonStore<ResearchReport>({
      filePath: paths.reportPath,
      schema: researchReportSchema as z.ZodType<ResearchReport>,
      writer: this.writer,
    });
    const result = store.write(report);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForResearchReport(report, {
        occurredAt,
        eventId: `audit-research-${safeIdentifier(this.idGenerator())}`,
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
      throw new Error("ResearchMemoryStore now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createResearchMemoryPaths(
  memoryDir: string,
  tradingDate: string,
  reportId: string,
  occurredAt?: string,
): ResearchMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const researchDir = path.join(resolvedMemoryDir, "research");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const tradingDateDir = path.join(researchDir, tradingDate);
  const auditDate = (occurredAt ?? tradingDate).slice(0, 10);

  return {
    researchDir,
    logsDir,
    tradingDateDir,
    reportPath: path.join(tradingDateDir, `${safeFileName(reportId)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForResearchReport(
  report: ResearchReport,
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
    actor: {
      type: "system",
      id: "research-memory-store",
    },
    action: "write",
    subject: {
      type: "report",
      id: report.reportId,
    },
    severity: report.degraded ? "warning" : "info",
    result: "success",
    message: `Research report ${report.reportId} written`,
    correlationId: report.taskId,
    metadata: {
      reportId: report.reportId,
      taskId: report.taskId,
      provider: report.provider,
      symbol: report.symbol,
      market: report.market,
      tradingDate: report.tradingDate,
      degraded: report.degraded,
      tradeIntentDraftCount: report.tradeIntentDrafts.length,
      requiresHumanReview: report.requiresHumanReview,
      filePath: path.normalize(options.reportPath),
      backupPath: options.reportBackupPath ? path.normalize(options.reportBackupPath) : null,
      liveTrading: false,
    },
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "research-report";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
