import path from "node:path";
import type { z } from "zod";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import { ruleChangeProposalSchema, type RuleChangeProposal } from "../../domain/decision/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface RuleProposalMemoryPaths {
  proposalsDir: string;
  logsDir: string;
  proposalPath: string;
  auditLogPath: string;
}

export interface RuleProposalMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface RuleProposalWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

/**
 * Persists rule-change proposals under `memory/rule-proposals/`. Every proposal is
 * pending human review and `autoApply: false` — the audit event records that, so the
 * trail makes clear nothing was ever auto-applied.
 */
export class RuleProposalMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: RuleProposalMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeProposal(proposal: RuleChangeProposal): RuleProposalWriteResult {
    const occurredAt = this.isoNow();
    const paths = createRuleProposalMemoryPaths(this.memoryDir, proposal.proposalId, occurredAt);
    const store = new JsonStore<RuleChangeProposal>({
      filePath: paths.proposalPath,
      schema: ruleChangeProposalSchema as z.ZodType<RuleChangeProposal>,
      writer: this.writer,
    });
    const result = store.write(proposal);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForProposal(proposal, {
        occurredAt,
        eventId: `audit-ruleprop-${safeIdentifier(this.idGenerator())}`,
        proposalPath: result.filePath,
        proposalBackupPath: result.backupPath,
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
      throw new Error("RuleProposalMemoryStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

export function createRuleProposalMemoryPaths(
  memoryDir: string,
  proposalId: string,
  occurredAt?: string,
): RuleProposalMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const proposalsDir = path.join(resolvedMemoryDir, "rule-proposals");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const auditDate = (occurredAt ?? new Date(0).toISOString()).slice(0, 10);

  return {
    proposalsDir,
    logsDir,
    proposalPath: path.join(proposalsDir, `${safeFileName(proposalId)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForProposal(
  proposal: RuleChangeProposal,
  options: {
    occurredAt: string;
    eventId: string;
    proposalPath: string;
    proposalBackupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: { type: "system", id: "rule-proposal-store" },
    action: "suggest",
    subject: { type: "config", id: proposal.proposalId },
    severity: "info",
    result: "success",
    message: `Rule-change proposal ${proposal.proposalId} drafted (pending human review)`,
    metadata: {
      proposalId: proposal.proposalId,
      observedVerdict: proposal.observedVerdict,
      sampleSize: proposal.sampleSize,
      hitRate: proposal.hitRate,
      status: proposal.status,
      autoApply: proposal.autoApply,
      requiresHumanApproval: proposal.requiresHumanApproval,
      filePath: path.normalize(options.proposalPath),
      backupPath: options.proposalBackupPath ? path.normalize(options.proposalBackupPath) : null,
      liveTrading: false,
    },
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "rule-proposal";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
