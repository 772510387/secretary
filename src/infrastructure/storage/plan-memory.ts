import path from "node:path";
import type { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import { dailyTradingPlanSchema, type DailyTradingPlan } from "../../domain/plan/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface PlanMemoryPaths {
  plansDir: string;
  logsDir: string;
  dateDir: string;
  planPath: string;
  auditLogPath: string;
}

export interface PlanMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface PlanWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

/**
 * Persists the daily trading plan, one file per node revision (so the full intra-day
 * evolution of the funnel is reproducible). Mirrors the other memory stores: validate ->
 * JsonStore.write (atomic + backup) -> redacted audit. Read-only analysis artifact; it
 * carries no execution authority.
 */
export class PlanMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: PlanMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writePlan(plan: DailyTradingPlan): PlanWriteResult {
    const occurredAt = this.isoNow();
    const paths = createPlanMemoryPaths(
      this.memoryDir,
      plan.tradingDate,
      plan.planId,
      plan.nodeSequence,
      occurredAt,
    );
    const store = new JsonStore<DailyTradingPlan>({
      filePath: paths.planPath,
      schema: dailyTradingPlanSchema as z.ZodType<DailyTradingPlan>,
      writer: this.writer,
    });
    const result = store.write(plan);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForPlan(plan, {
        occurredAt,
        eventId: `audit-plan-${safeIdentifier(this.idGenerator())}`,
        planPath: result.filePath,
        planBackupPath: result.backupPath,
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
      throw new Error("PlanMemoryStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createPlanMemoryPaths(
  memoryDir: string,
  tradingDate: string,
  planId: string,
  nodeSequence: number,
  occurredAt?: string,
): PlanMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const plansDir = path.join(resolvedMemoryDir, "plans");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const dateDir = path.join(plansDir, tradingDate);
  const auditDate = (occurredAt ?? tradingDate).slice(0, 10);

  return {
    plansDir,
    logsDir,
    dateDir,
    planPath: path.join(dateDir, `${safeFileName(planId)}-seq${nodeSequence}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForPlan(
  plan: DailyTradingPlan,
  options: { occurredAt: string; eventId: string; planPath: string; planBackupPath?: string },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: { type: "system", id: "plan-memory-store" },
    action: "write",
    subject: { type: "memory", id: plan.planId },
    severity: "info",
    result: "success",
    message: `Daily trading plan ${plan.planId} (seq ${plan.nodeSequence}) written`,
    correlationId: plan.accountId,
    metadata: {
      planId: plan.planId,
      tradingDate: plan.tradingDate,
      accountId: plan.accountId,
      nodeSequence: plan.nodeSequence,
      alarmType: plan.alarmType,
      watchlistCount: plan.watchlist100.length,
      shortlistCount: plan.shortlist10.length,
      pendingOrderCount: plan.pendingOrders.length,
      autoPaper: plan.safety.autoPaper,
      liveTrading: plan.safety.liveTrading,
      filePath: path.normalize(options.planPath),
      backupPath: options.planBackupPath ? path.normalize(options.planBackupPath) : null,
    },
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "plan";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
