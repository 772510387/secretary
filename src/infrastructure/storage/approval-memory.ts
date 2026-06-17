import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  applyApprovalToProposal,
  approvalRecordSchema,
  reviewProposalSchema,
  type ApprovalRecord,
  type ReviewProposal,
} from "../../domain/memory/index.js";
import { appendAuditEvent } from "../logging/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";
import { createProposalMemoryPaths } from "./proposal-memory.js";

export interface ApprovalMemoryPaths {
  proposalsDir: string;
  approvalsPath: string;
  logsDir: string;
  auditLogPath: string;
}

export interface ApprovalRecordStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ApprovalRecordWriteResult extends AtomicWriteResult {
  auditLogPath: string;
  auditBackupPath?: string;
}

export interface ReviewProposalWithApprovalResult {
  approvalWrite: ApprovalRecordWriteResult;
  proposalWrite: AtomicWriteResult;
  proposalAuditLogPath: string;
  proposalAuditBackupPath?: string;
  approval: ApprovalRecord;
  proposal: ReviewProposal;
}

export class ApprovalRecordStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: ApprovalRecordStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeApproval(recordInput: ApprovalRecord): ApprovalRecordWriteResult {
    const record = approvalRecordSchema.parse(recordInput);
    assertNoSensitiveApprovalText(record);
    const occurredAt = this.isoNow();
    const paths = createApprovalMemoryPaths(this.memoryDir, record.reviewedAt, occurredAt);
    const previous = existsSync(paths.approvalsPath) ? readFileSync(paths.approvalsPath, "utf8") : "";
    const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";
    const write = this.writer.write(
      paths.approvalsPath,
      `${previous}${separator}${JSON.stringify(record)}\n`,
    );
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForApproval(record, {
        occurredAt,
        eventId: `audit-approval-${safeIdentifier(this.idGenerator())}`,
        filePath: write.filePath,
        backupPath: write.backupPath,
      }),
      this.writer,
    );

    return {
      ...write,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  reviewProposalWithApproval(recordInput: ApprovalRecord): ReviewProposalWithApprovalResult {
    const record = approvalRecordSchema.parse(recordInput);
    const existing = this.findProposal(record.proposalId);

    if (!existing) {
      throw new ApprovalRecordStoreError(`Proposal ${record.proposalId} was not found`);
    }

    const reviewed = applyApprovalToProposal(existing.proposal, record);
    const approvalWrite = this.writeApproval(record);
    const proposalPaths = createProposalMemoryPaths(
      this.memoryDir,
      reviewed.createdAt,
      reviewed.proposalId,
      this.isoNow(),
    );
    const proposalStore = new JsonStore<ReviewProposal>({
      filePath: proposalPaths.proposalPath,
      schema: reviewProposalSchema as z.ZodType<ReviewProposal>,
      writer: this.writer,
    });
    const proposalWrite = proposalStore.write(reviewed);
    const proposalAudit = appendAuditEvent(
      proposalPaths.auditLogPath,
      auditEventForReviewedProposal(reviewed, record, {
        occurredAt: this.isoNow(),
        eventId: `audit-proposal-review-${safeIdentifier(this.idGenerator())}`,
        filePath: proposalWrite.filePath,
        backupPath: proposalWrite.backupPath,
      }),
      this.writer,
    );

    return {
      approvalWrite,
      proposalWrite,
      proposalAuditLogPath: proposalAudit.filePath,
      proposalAuditBackupPath: proposalAudit.backupPath,
      approval: record,
      proposal: reviewed,
    };
  }

  findProposal(proposalId: string): { proposal: ReviewProposal; filePath: string } | undefined {
    const safeProposalId = safeFileName(proposalId);
    const proposalsDir = path.join(this.memoryDir, "proposals");

    if (!existsSync(proposalsDir)) {
      return undefined;
    }

    for (const filePath of listJsonFiles(proposalsDir)) {
      if (path.basename(filePath) !== `${safeProposalId}.json`) {
        continue;
      }

      const proposal = reviewProposalSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));

      if (proposal.success) {
        return {
          proposal: proposal.data,
          filePath,
        };
      }
    }

    return undefined;
  }

  listProposals(options: { status?: ReviewProposal["status"] } = {}): ReviewProposal[] {
    const proposalsDir = path.join(this.memoryDir, "proposals");

    if (!existsSync(proposalsDir)) {
      return [];
    }

    return listJsonFiles(proposalsDir)
      .map((filePath) => {
        const result = reviewProposalSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
        return result.success ? result.data : undefined;
      })
      .filter((proposal): proposal is ReviewProposal => proposal !== undefined)
      .filter((proposal) => options.status === undefined || proposal.status === options.status)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new ApprovalRecordStoreError("ApprovalRecordStore now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createApprovalMemoryPaths(
  memoryDir: string,
  reviewedAt: string,
  occurredAt: string = new Date().toISOString(),
): ApprovalMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const reviewDate = reviewedAt.slice(0, 10);
  const auditDate = occurredAt.slice(0, 10);

  return {
    proposalsDir: path.join(resolvedMemoryDir, "proposals"),
    approvalsPath: path.join(resolvedMemoryDir, "proposals", `approvals-${reviewDate}.jsonl`),
    logsDir: path.join(resolvedMemoryDir, "logs"),
    auditLogPath: path.join(resolvedMemoryDir, "logs", `audit-${auditDate}.jsonl`),
  };
}

function auditEventForApproval(
  record: ApprovalRecord,
  options: {
    occurredAt: string;
    eventId: string;
    filePath: string;
    backupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "user",
      id: record.reviewer.id,
    },
    action: "validate",
    subject: {
      type: "memory",
      id: record.proposalId,
    },
    severity: record.decision === "approved" ? "warning" : "info",
    result: record.decision === "approved" ? "success" : "rejected",
    message: `Approval ${record.approvalId} recorded for proposal ${record.proposalId}`,
    correlationId: record.requestId ?? record.proposalId,
    causationId: record.approvalId,
    metadata: {
      approvalId: record.approvalId,
      proposalId: record.proposalId,
      decision: record.decision,
      reviewerType: record.reviewer.type,
      reviewerId: record.reviewer.id ?? null,
      reviewedAt: record.reviewedAt,
      operatorSessionId: record.operatorSessionId,
      riskSnapshotRef: record.riskSnapshotRef,
      reviewNoteLength: record.reviewNote?.length ?? 0,
      filePath: path.normalize(options.filePath),
      backupPath: options.backupPath ? path.normalize(options.backupPath) : null,
      tokenLogged: false,
      brokerSubmissionAllowed: false,
      directBrokerHandoff: false,
      liveTradingAllowed: false,
    },
  });
}

function auditEventForReviewedProposal(
  proposal: ReviewProposal,
  record: ApprovalRecord,
  options: {
    occurredAt: string;
    eventId: string;
    filePath: string;
    backupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "system",
      id: "approval-record-store",
    },
    action: "validate",
    subject: {
      type: "memory",
      id: proposal.proposalId,
    },
    severity: record.decision === "approved" ? "warning" : "info",
    result: record.decision === "approved" ? "success" : "rejected",
    message: `Proposal ${proposal.proposalId} marked ${record.decision}`,
    correlationId: record.requestId ?? proposal.proposalId,
    causationId: record.approvalId,
    metadata: {
      approvalId: record.approvalId,
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      status: proposal.status,
      decision: record.decision,
      operatorSessionId: record.operatorSessionId,
      riskSnapshotRef: record.riskSnapshotRef,
      filePath: path.normalize(options.filePath),
      backupPath: options.backupPath ? path.normalize(options.backupPath) : null,
      brokerSubmissionAllowed: false,
      directBrokerHandoff: false,
      liveTradingAllowed: false,
    },
  });
}

function assertNoSensitiveApprovalText(record: ApprovalRecord): void {
  const serialized = JSON.stringify(record);

  if (/(api[_-]?key|authorization|cookie|password|passwd|secret|token)\s*[:=]/i.test(serialized)) {
    throw new ApprovalRecordStoreError("ApprovalRecord must not contain secret-like fields or values");
  }

  if (/\b(sk|ak|tk)-[A-Za-z0-9_-]{8,}\b/i.test(serialized)) {
    throw new ApprovalRecordStoreError("ApprovalRecord must not contain token-like values");
  }
}

function listJsonFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }

  return files;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "proposal";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 96);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

export class ApprovalRecordStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRecordStoreError";
  }
}
