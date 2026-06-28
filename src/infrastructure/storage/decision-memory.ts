import path from "node:path";
import type { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import { scoredDecisionSchema, type ScoredDecision } from "../../domain/decision/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface DecisionMemoryPaths {
  decisionsDir: string;
  logsDir: string;
  dateDir: string;
  decisionPath: string;
  auditLogPath: string;
}

export interface DecisionMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface DecisionWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

/**
 * Persists scored replay decisions, mirroring the other memory stores: validate ->
 * JsonStore.write (atomic + backup) -> append a redacted audit event (portfolio /
 * decision aggregates only; no per-stance returns). Read-only analysis artifacts.
 */
export class DecisionMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: DecisionMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeDecision(decision: ScoredDecision): DecisionWriteResult {
    const occurredAt = this.isoNow();
    const paths = createDecisionMemoryPaths(
      this.memoryDir,
      decision.asOfDate,
      decision.decisionId,
      occurredAt,
    );
    const store = new JsonStore<ScoredDecision>({
      filePath: paths.decisionPath,
      schema: scoredDecisionSchema as z.ZodType<ScoredDecision>,
      writer: this.writer,
    });
    const result = store.write(decision);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForDecision(decision, {
        occurredAt,
        eventId: `audit-decision-${safeIdentifier(this.idGenerator())}`,
        decisionPath: result.filePath,
        decisionBackupPath: result.backupPath,
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
      throw new Error("DecisionMemoryStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createDecisionMemoryPaths(
  memoryDir: string,
  asOfDate: string,
  decisionId: string,
  occurredAt?: string,
): DecisionMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const decisionsDir = path.join(resolvedMemoryDir, "decisions");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const dateDir = path.join(decisionsDir, asOfDate);
  const auditDate = (occurredAt ?? asOfDate).slice(0, 10);

  return {
    decisionsDir,
    logsDir,
    dateDir,
    decisionPath: path.join(dateDir, `${safeFileName(decisionId)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForDecision(
  decision: ScoredDecision,
  options: {
    occurredAt: string;
    eventId: string;
    decisionPath: string;
    decisionBackupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: { type: "system", id: "decision-memory-store" },
    action: "write",
    subject: { type: "memory", id: decision.decisionId },
    severity: "info",
    result: "success",
    message: `Scored replay decision ${decision.decisionId} written`,
    correlationId: decision.snapshotId,
    metadata: {
      decisionId: decision.decisionId,
      snapshotId: decision.snapshotId,
      accountId: decision.accountId,
      asOfDate: decision.asOfDate,
      alarmId: decision.alarmId,
      horizonTradingDays: decision.horizonTradingDays,
      stanceCount: decision.stances.length,
      scoredCount: decision.summary.scoredCount,
      hitCount: decision.summary.hitCount,
      hitRate: decision.summary.hitRate,
      avgForwardReturn: decision.summary.avgForwardReturn,
      strategyIds: uniqueStrategyIds(decision),
      executable: decision.executable,
      reviewRequired: decision.reviewRequired,
      filePath: path.normalize(options.decisionPath),
      backupPath: options.decisionBackupPath ? path.normalize(options.decisionBackupPath) : null,
      liveTrading: false,
    },
  });
}

function uniqueStrategyIds(decision: ScoredDecision): string[] {
  return [
    ...new Set(
      decision.stances.flatMap((stance) => stance.strategyIds ?? []).filter((strategyId) => strategyId.trim() !== ""),
    ),
  ].sort();
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "decision";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
