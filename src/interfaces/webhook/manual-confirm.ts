import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  createApprovalRecord,
  type ApprovalRecord,
  type ReviewProposal,
} from "../../domain/memory/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../../domain/shared/index.js";
import { appendAuditEvent } from "../../infrastructure/logging/index.js";
import {
  ApprovalRecordStore,
  ApprovalRecordStoreError,
  AtomicFileWriter,
  createApprovalMemoryPaths,
} from "../../infrastructure/storage/index.js";
import {
  webhookAccessAuditSchema,
  webhookAuthSchema,
  webhookSecurityStateSchema,
  webhookSourceSchema,
  type WebhookAccessAudit,
  type WebhookSecurityState,
} from "./schemas.js";

export const manualConfirmApiPayloadSchema = z
  .object({
    proposalId: identifierSchema,
    approvalId: identifierSchema.optional(),
    decision: z.enum(["approved", "rejected"]),
    reviewerId: identifierSchema.optional(),
    operatorSessionId: identifierSchema,
    riskSnapshotRef: z.string().trim().min(1).max(240),
    note: z.string().trim().min(1).max(1000).optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const manualConfirmApiRequestSchema = z
  .object({
    requestId: identifierSchema,
    occurredAt: isoDateTimeSchema.optional(),
    source: webhookSourceSchema,
    auth: webhookAuthSchema,
    payload: manualConfirmApiPayloadSchema,
  })
  .strict();

export type ManualConfirmApiPayload = z.infer<typeof manualConfirmApiPayloadSchema>;
export type ManualConfirmApiRequest = z.infer<typeof manualConfirmApiRequestSchema>;
export type ManualConfirmApiStatus = "accepted" | "rejected" | "unauthorized" | "skipped_duplicate";

export interface HandleManualConfirmRequestOptions {
  memoryDir: string;
  expectedToken?: string;
  securityState?: WebhookSecurityState;
  now?: Date | string;
  writer?: AtomicFileWriter;
  idGenerator?: () => string;
}

export interface ManualConfirmApiResult {
  status: ManualConfirmApiStatus;
  requestId: string;
  occurredAt: string;
  approval?: ApprovalRecord;
  proposal?: ReviewProposal;
  rejectionReasons: string[];
  auditEvent: AuditEvent;
  accessAudit: WebhookAccessAudit;
  nextSecurityState: WebhookSecurityState;
  brokerSubmissionAllowed: false;
  liveTradingAllowed: false;
}

export function handleManualConfirmRequest(
  input: unknown,
  options: HandleManualConfirmRequestOptions,
): ManualConfirmApiResult {
  const occurredAt = normalizeDate(options.now ?? new Date()).toISOString();
  const idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  const writer = options.writer ?? new AtomicFileWriter();
  const initialState = webhookSecurityStateSchema.parse(options.securityState ?? {});
  const parsed = manualConfirmApiRequestSchema.safeParse(input);

  if (!parsed.success) {
    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "rejected",
      requestId: requestIdFromUnknown(input),
      occurredAt,
      rejectionReasons: ["invalid_schema"],
      nextSecurityState: initialState,
      idGenerator,
      metadata: {
        validationIssueCount: parsed.error.issues.length,
      },
    });
  }

  const request = parsed.data;
  const requestTime = normalizeDate(options.now ?? request.occurredAt ?? new Date()).toISOString();

  if (!options.expectedToken?.trim()) {
    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "unauthorized",
      request,
      requestId: request.requestId,
      occurredAt: requestTime,
      rejectionReasons: ["auth_not_configured"],
      nextSecurityState: initialState,
      idGenerator,
      metadata: authMetadata(request, "not_configured"),
    });
  }

  if (!timingSafeEqualString(request.auth.token, options.expectedToken)) {
    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "unauthorized",
      request,
      requestId: request.requestId,
      occurredAt: requestTime,
      rejectionReasons: ["auth_failed"],
      nextSecurityState: initialState,
      idGenerator,
      metadata: authMetadata(request, "failed"),
    });
  }

  if (initialState.recentRequestIds[request.requestId] !== undefined) {
    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "skipped_duplicate",
      request,
      requestId: request.requestId,
      occurredAt: requestTime,
      rejectionReasons: ["duplicate_request"],
      nextSecurityState: initialState,
      idGenerator,
      metadata: {
        ...authMetadata(request, "passed"),
        firstSeenAt: initialState.recentRequestIds[request.requestId],
      },
    });
  }

  const nextSecurityState = webhookSecurityStateSchema.parse({
    ...initialState,
    recentRequestIds: {
      ...initialState.recentRequestIds,
      [request.requestId]: requestTime,
    },
  });
  const approval = createApprovalRecord({
    approvalId: request.payload.approvalId ?? `approval-${safeIdentifier(request.requestId, 80)}`,
    proposalId: request.payload.proposalId,
    decision: request.payload.decision,
    reviewer: {
      type: "user",
      id: request.payload.reviewerId ?? request.source.operatorId ?? request.source.sourceId,
    },
    reviewedAt: requestTime,
    operatorSessionId: request.payload.operatorSessionId,
    riskSnapshotRef: request.payload.riskSnapshotRef,
    reviewNote: request.payload.note,
    requestId: request.requestId,
    metadata: {
      ...request.payload.metadata,
      sourceType: request.source.sourceType,
      sourceId: request.source.sourceId,
      tokenLogged: false,
      brokerSubmissionAllowed: false,
      directBrokerHandoff: false,
    },
  });

  try {
    const store = new ApprovalRecordStore({
      memoryDir: options.memoryDir,
      writer,
      now: () => new Date(requestTime),
      idGenerator,
    });
    const write = store.reviewProposalWithApproval(approval);

    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "accepted",
      request,
      requestId: request.requestId,
      occurredAt: requestTime,
      approval,
      proposal: write.proposal,
      rejectionReasons: [],
      nextSecurityState,
      idGenerator,
      metadata: {
        ...authMetadata(request, "passed"),
        approvalId: approval.approvalId,
        proposalId: approval.proposalId,
        decision: approval.decision,
        proposalStatus: write.proposal.status,
        approvalPath: path.normalize(write.approvalWrite.filePath),
        proposalPath: path.normalize(write.proposalWrite.filePath),
      },
    });
  } catch (error) {
    return finalizeResult({
      memoryDir: options.memoryDir,
      writer,
      status: "rejected",
      request,
      requestId: request.requestId,
      occurredAt: requestTime,
      rejectionReasons: ["approval_failed"],
      nextSecurityState,
      idGenerator,
      metadata: {
        ...authMetadata(request, "passed"),
        errorName: error instanceof Error ? error.name : "unknown",
        errorMessage: sanitizeText(error instanceof Error ? error.message : String(error)),
      },
    });
  }
}

function finalizeResult(input: {
  memoryDir: string;
  writer: AtomicFileWriter;
  status: ManualConfirmApiStatus;
  request?: ManualConfirmApiRequest;
  requestId: string;
  occurredAt: string;
  approval?: ApprovalRecord;
  proposal?: ReviewProposal;
  rejectionReasons: string[];
  nextSecurityState: WebhookSecurityState;
  idGenerator: () => string;
  metadata: Record<string, unknown>;
}): ManualConfirmApiResult {
  const auditEvent = auditEventForManualConfirm(input);
  const paths = createApprovalMemoryPaths(input.memoryDir, input.occurredAt, input.occurredAt);

  appendAuditEvent(paths.auditLogPath, auditEvent, input.writer);

  return {
    status: input.status,
    requestId: input.requestId,
    occurredAt: input.occurredAt,
    approval: input.approval,
    proposal: input.proposal,
    rejectionReasons: input.rejectionReasons,
    auditEvent,
    accessAudit: webhookAccessAuditSchema.parse({
      auditId: auditEvent.eventId,
      requestId: input.requestId,
      source: {
        sourceType: input.request?.source.sourceType ?? "unknown",
        sourceId: input.request?.source.sourceId ?? "unknown",
        operatorId: input.request?.source.operatorId,
      },
      eventType: "manual_confirm",
      result: input.status,
      occurredAt: input.occurredAt,
      duplicate: input.status === "skipped_duplicate",
      rateLimited: false,
      rejectionReasons: input.rejectionReasons,
      tokenLogged: false,
      secretHeaderLogged: false,
      payloadLogged: false,
      sensitiveBodyLogged: false,
    }),
    nextSecurityState: input.nextSecurityState,
    brokerSubmissionAllowed: false,
    liveTradingAllowed: false,
  };
}

function auditEventForManualConfirm(input: {
  status: ManualConfirmApiStatus;
  request?: ManualConfirmApiRequest;
  requestId: string;
  occurredAt: string;
  rejectionReasons: string[];
  idGenerator: () => string;
  metadata: Record<string, unknown>;
}): AuditEvent {
  const success = input.status === "accepted";

  return auditEventSchema.parse({
    eventId: `audit-manual-confirm-api-${safeIdentifier(input.idGenerator(), 80)}`,
    occurredAt: input.occurredAt,
    actor: {
      type: "api",
      id: "manual-confirm-webhook",
    },
    action: "validate",
    subject: {
      type: "memory",
      id: input.request?.payload.proposalId ?? input.requestId,
    },
    severity: success ? "warning" : "info",
    result: success ? "success" : input.status === "skipped_duplicate" ? "skipped" : "rejected",
    message: `Manual confirm API ${input.status} request ${input.requestId}`,
    correlationId: input.requestId,
    metadata: sanitizeMetadata({
      requestId: input.requestId,
      eventType: "manual_confirm",
      rejectionReasons: input.rejectionReasons,
      tokenLogged: false,
      brokerSubmissionAllowed: false,
      directBrokerHandoff: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      ...input.metadata,
    }),
  });
}

function authMetadata(
  request: ManualConfirmApiRequest,
  authResult: "passed" | "failed" | "not_configured",
): Record<string, unknown> {
  return {
    authResult,
    authScheme: request.auth.scheme,
    authTokenId: request.auth.tokenId ?? null,
    tokenLogged: false,
  };
}

function requestIdFromUnknown(input: unknown): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const requestId = (input as Record<string, unknown>).requestId;

    if (typeof requestId === "string") {
      return safeIdentifier(requestId, 96);
    }
  }

  return "manual-confirm-invalid";
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ApprovalRecordStoreError("Invalid manual confirm API date");
    }

    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ApprovalRecordStoreError(`Invalid manual confirm API date: ${value}`);
  }

  return parsed;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = /token|secret|password|authorization|cookie/i.test(key)
      ? "[redacted]"
      : sanitizeValue(child);
  }

  return output;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (typeof value === "object" && value !== null) {
    return sanitizeMetadata(value as Record<string, unknown>);
  }

  return null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\b(sk|ak|tk)-[A-Za-z0-9_-]{8,}\b/gi, "$1-<redacted>")
    .replace(
      /(api[_-]?key|authorization|cookie|password|passwd|secret|token)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2<redacted>",
    );
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
