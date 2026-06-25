import path from "node:path";
import type { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import {
  pointInTimeSnapshotSchema,
  type PointInTimeSnapshot,
} from "../../domain/portfolio/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface PortfolioSnapshotMemoryPaths {
  snapshotsDir: string;
  logsDir: string;
  dateDir: string;
  snapshotPath: string;
  auditLogPath: string;
}

export interface PortfolioSnapshotMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface PortfolioSnapshotWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

/**
 * Persists point-in-time replay snapshots, mirroring {@link ResearchMemoryStore}:
 * validate -> JsonStore.write (atomic + backup) -> append a REDACTED audit event.
 * The audit metadata deliberately excludes per-position pnl/latestPrice/costPrice
 * (sensitivity redaction), keeping only portfolio-level aggregates.
 */
export class PortfolioSnapshotMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: PortfolioSnapshotMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeSnapshot(snapshot: PointInTimeSnapshot): PortfolioSnapshotWriteResult {
    const occurredAt = this.isoNow();
    const paths = createPortfolioSnapshotMemoryPaths(
      this.memoryDir,
      snapshot.asOfDate,
      snapshot.snapshotId,
      occurredAt,
    );
    const store = new JsonStore<PointInTimeSnapshot>({
      filePath: paths.snapshotPath,
      schema: pointInTimeSnapshotSchema as z.ZodType<PointInTimeSnapshot>,
      writer: this.writer,
    });
    const result = store.write(snapshot);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForSnapshot(snapshot, {
        occurredAt,
        eventId: `audit-snapshot-${safeIdentifier(this.idGenerator())}`,
        snapshotPath: result.filePath,
        snapshotBackupPath: result.backupPath,
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
      throw new Error("PortfolioSnapshotMemoryStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createPortfolioSnapshotMemoryPaths(
  memoryDir: string,
  asOfDate: string,
  snapshotId: string,
  occurredAt?: string,
): PortfolioSnapshotMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const snapshotsDir = path.join(resolvedMemoryDir, "snapshots");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const dateDir = path.join(snapshotsDir, asOfDate);
  const auditDate = (occurredAt ?? asOfDate).slice(0, 10);

  return {
    snapshotsDir,
    logsDir,
    dateDir,
    snapshotPath: path.join(dateDir, `${safeFileName(snapshotId)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForSnapshot(
  snapshot: PointInTimeSnapshot,
  options: {
    occurredAt: string;
    eventId: string;
    snapshotPath: string;
    snapshotBackupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: { type: "system", id: "portfolio-snapshot-store" },
    action: "write",
    subject: { type: "memory", id: snapshot.snapshotId },
    severity: snapshot.metadata.degraded ? "warning" : "info",
    result: "success",
    message: `Point-in-time snapshot ${snapshot.snapshotId} written`,
    correlationId: snapshot.jobId,
    metadata: {
      snapshotId: snapshot.snapshotId,
      accountId: snapshot.accountId,
      asOfDate: snapshot.asOfDate,
      asOfTime: snapshot.asOfTime,
      alarmId: snapshot.alarmId,
      alarmType: snapshot.alarmType,
      positionCount: snapshot.positions.length,
      totalAssets: snapshot.valuation.totalAssets,
      investedRatio: snapshot.valuation.investedRatio,
      cashTotal: snapshot.valuation.cash.total,
      pricesAvailable: snapshot.market.pricesAvailable,
      indicesAvailable: snapshot.metadata.indicesAvailable,
      degraded: snapshot.metadata.degraded,
      filePath: path.normalize(options.snapshotPath),
      backupPath: options.snapshotBackupPath ? path.normalize(options.snapshotBackupPath) : null,
      liveTrading: false,
    },
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "snapshot";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
