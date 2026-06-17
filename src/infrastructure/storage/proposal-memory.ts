import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  reviewProposalSchema,
  type TradeIntentReviewProposal,
  type ReviewProposal,
} from "../../domain/memory/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface ProposalMemoryPaths {
  proposalsDir: string;
  logsDir: string;
  proposalDateDir: string;
  proposalPath: string;
  auditLogPath: string;
}

export interface ProposalMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ProposalMemoryWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
}

export class ProposalMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: ProposalMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  writeProposal(proposal: ReviewProposal): ProposalMemoryWriteResult {
    const occurredAt = this.isoNow();
    const parsed = reviewProposalSchema.parse(proposal);
    const paths = createProposalMemoryPaths(
      this.memoryDir,
      parsed.createdAt,
      parsed.proposalId,
      occurredAt,
    );
    const store = new JsonStore<ReviewProposal>({
      filePath: paths.proposalPath,
      schema: reviewProposalSchema as z.ZodType<ReviewProposal>,
      writer: this.writer,
    });
    const result = store.write(parsed);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForProposal(parsed, {
        occurredAt,
        eventId: `audit-proposal-${safeIdentifier(this.idGenerator())}`,
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
      throw new Error("ProposalMemoryStore now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createProposalMemoryPaths(
  memoryDir: string,
  proposalCreatedAt: string,
  proposalId: string,
  occurredAt?: string,
): ProposalMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const proposalsDir = path.join(resolvedMemoryDir, "proposals");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const proposalDate = proposalCreatedAt.slice(0, 10);
  const auditDate = (occurredAt ?? proposalCreatedAt).slice(0, 10);
  const proposalDateDir = path.join(proposalsDir, proposalDate);

  return {
    proposalsDir,
    logsDir,
    proposalDateDir,
    proposalPath: path.join(proposalDateDir, `${safeFileName(proposalId)}.json`),
    auditLogPath: path.join(logsDir, `audit-${auditDate}.jsonl`),
  };
}

function auditEventForProposal(
  proposal: ReviewProposal,
  options: {
    occurredAt: string;
    eventId: string;
    proposalPath: string;
    proposalBackupPath?: string;
  },
): AuditEvent {
  if (proposal.proposalType === "memory_write_review") {
    return auditEventSchema.parse({
      eventId: options.eventId,
      occurredAt: options.occurredAt,
      actor: {
        type: "system",
        id: "proposal-memory-store",
      },
      action: "suggest",
      subject: {
        type: "memory",
        id: proposal.proposalId,
      },
      severity: "info",
      result: "success",
      message: `Memory write review proposal ${proposal.proposalId} written`,
      correlationId: proposal.source.requestId,
      causationId: proposal.request.requestedBy.sourceId,
      metadata: {
        proposalId: proposal.proposalId,
        proposalType: proposal.proposalType,
        status: proposal.status,
        requestId: proposal.source.requestId,
        requestedByType: proposal.source.requestedBy.sourceType,
        requestedById: proposal.source.requestedBy.sourceId ?? null,
        writeType: proposal.request.writeType,
        operation: proposal.request.operation,
        targetCategory: proposal.request.targetCategory,
        targetPath: proposal.request.targetPath,
        decisionStatus: proposal.decision.status,
        decisionReasons: proposal.decision.reasons,
        requiresProposal: proposal.decision.requiresProposal,
        autoApplyAllowed: proposal.decision.autoApplyAllowed,
        requiresManualReview: proposal.executionGuard.requiresManualReview,
        executable: proposal.executionGuard.executable,
        brokerSubmissionAllowed: proposal.executionGuard.brokerSubmissionAllowed,
        accountWriteAllowed: proposal.executionGuard.accountWriteAllowed,
        liveTradingAllowed: proposal.executionGuard.liveTradingAllowed,
        filePath: path.normalize(options.proposalPath),
        backupPath: options.proposalBackupPath
          ? path.normalize(options.proposalBackupPath)
          : null,
        liveTrading: false,
      },
    });
  }

  const sourceAudit = tradeIntentSourceAuditMetadata(proposal);

  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "system",
      id: "proposal-memory-store",
    },
    action: "suggest",
    subject: {
      type: "memory",
      id: proposal.proposalId,
    },
    severity: "info",
    result: "success",
    message: `Trade intent review proposal ${proposal.proposalId} written`,
    correlationId: sourceAudit.correlationId,
    causationId: sourceAudit.causationId,
    metadata: {
      proposalId: proposal.proposalId,
      proposalType: proposal.proposalType,
      status: proposal.status,
      ...sourceAudit.metadata,
      symbol: proposal.symbol,
      market: proposal.market,
      side: proposal.side,
      hasQuantity: proposal.quantity !== undefined,
      hasLimitPrice: proposal.limitPrice !== undefined,
      requiresManualReview: proposal.executionGuard.requiresManualReview,
      executable: proposal.executionGuard.executable,
      brokerSubmissionAllowed: proposal.executionGuard.brokerSubmissionAllowed,
      accountWriteAllowed: proposal.executionGuard.accountWriteAllowed,
      liveTradingAllowed: proposal.executionGuard.liveTradingAllowed,
      filePath: path.normalize(options.proposalPath),
      backupPath: options.proposalBackupPath
        ? path.normalize(options.proposalBackupPath)
        : null,
      liveTrading: false,
    },
  });
}

function tradeIntentSourceAuditMetadata(proposal: TradeIntentReviewProposal): {
  correlationId: string;
  causationId?: string;
  metadata: Record<string, string>;
} {
  if (proposal.source.sourceType === "research_report") {
    return {
      correlationId: proposal.source.reportId,
      causationId: proposal.source.draftId,
      metadata: {
        sourceType: proposal.source.sourceType,
        sourceReportId: proposal.source.reportId,
        sourceTaskId: proposal.source.taskId,
        sourceDraftId: proposal.source.draftId,
        provider: proposal.source.provider,
      },
    };
  }

  return {
    correlationId: proposal.source.requestId,
    metadata: {
      sourceType: proposal.source.sourceType,
      sourceRequestId: proposal.source.requestId,
      sourceToolType: proposal.source.toolType,
    },
  };
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128) || "proposal";
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
