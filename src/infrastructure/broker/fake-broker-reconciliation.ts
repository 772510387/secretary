import path from "node:path";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../../domain/notification/index.js";
import {
  maskAccountId,
  reconcilePortfolioSnapshots,
  type ReconciliationResult,
  type ReconciliationSnapshot,
} from "../../domain/trading/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain/shared/index.js";
import { appendAuditEvent } from "../logging/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "../storage/index.js";
import type { ReadOnlyBroker } from "./read-only-broker.js";

export interface FakeBrokerReconciliationOptions {
  memoryDir: string;
  broker: ReadOnlyBroker;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface RunFakeBrokerReconciliationInput {
  requestId: string;
  accountId: string;
  local: ReconciliationSnapshot;
  metadata?: Record<string, unknown>;
}

export interface FakeBrokerReconciliationResult {
  reconciliation: ReconciliationResult;
  auditEvent: AuditEvent;
  auditWrite: AtomicWriteResult;
  notificationEvent?: NotificationEvent;
}

export class FakeBrokerReconciliationService {
  private readonly memoryDir: string;
  private readonly broker: ReadOnlyBroker;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: FakeBrokerReconciliationOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.broker = options.broker;
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  async run(input: RunFakeBrokerReconciliationInput): Promise<FakeBrokerReconciliationResult> {
    const requestId = identifierSchema.parse(input.requestId);
    const accountId = identifierSchema.parse(input.accountId);
    const checkedAt = this.isoNow();
    const brokerSnapshot = await this.readBrokerSnapshot({
      requestId,
      accountId,
      requestedAt: checkedAt,
    });
    const reconciliation = reconcilePortfolioSnapshots({
      reconciliationId: `reconciliation-${safeIdentifier(this.idGenerator())}`,
      accountId,
      checkedAt,
      local: input.local,
      broker: brokerSnapshot,
      metadata: {
        ...input.metadata,
        requestId,
        source: "fake-broker-reconciliation-service",
      },
    });
    const auditEvent = auditEventForReconciliation(reconciliation, {
      requestId,
      occurredAt: checkedAt,
    });
    const auditWrite = appendAuditEvent(
      createBrokerReconciliationAuditPath(this.memoryDir, checkedAt),
      auditEvent,
      this.writer,
    );
    const notificationEvent = reconciliation.status === "matched"
      ? undefined
      : notificationEventForReconciliation(reconciliation, {
          requestId,
          occurredAt: checkedAt,
          auditEventId: auditEvent.eventId,
        });

    return {
      reconciliation,
      auditEvent,
      auditWrite,
      notificationEvent,
    };
  }

  private async readBrokerSnapshot(input: {
    requestId: string;
    accountId: string;
    requestedAt: string;
  }): Promise<ReconciliationSnapshot> {
    const base = {
      accountId: input.accountId,
      requestedAt: input.requestedAt,
    };

    const [account, positions, orders, executions] = await Promise.all([
      this.broker.getAccountSnapshot({
        ...base,
        requestId: `${input.requestId}-account`,
      }),
      this.broker.getPositions({
        ...base,
        requestId: `${input.requestId}-positions`,
      }),
      this.broker.getOrders({
        ...base,
        requestId: `${input.requestId}-orders`,
      }),
      this.broker.getExecutions({
        ...base,
        requestId: `${input.requestId}-executions`,
      }),
    ]);

    return {
      account,
      positions,
      orders,
      executions,
    };
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("FakeBrokerReconciliationService now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createBrokerReconciliationAuditPath(
  memoryDir: string,
  occurredAt: string = new Date().toISOString(),
): string {
  return path.join(path.resolve(memoryDir), "logs", `audit-${occurredAt.slice(0, 10)}.jsonl`);
}

function auditEventForReconciliation(
  reconciliation: ReconciliationResult,
  options: {
    requestId: string;
    occurredAt: string;
  },
): AuditEvent {
  const failed = reconciliation.status !== "matched";

  return auditEventSchema.parse({
    eventId: `audit-reconciliation-${safeIdentifier(reconciliation.reconciliationId)}`,
    occurredAt: isoDateTimeSchema.parse(options.occurredAt),
    actor: {
      type: "system",
      id: "fake-broker-reconciliation-service",
    },
    action: "validate",
    subject: {
      type: "risk",
      id: reconciliation.reconciliationId,
    },
    severity: failed ? "critical" : "info",
    result: failed ? "failure" : "success",
    message: failed
      ? `Broker reconciliation ${reconciliation.reconciliationId} requires manual review`
      : `Broker reconciliation ${reconciliation.reconciliationId} matched`,
    correlationId: options.requestId,
    metadata: {
      requestId: options.requestId,
      reconciliationId: reconciliation.reconciliationId,
      status: reconciliation.status,
      account: maskAccountId(reconciliation.accountId),
      issueCount: reconciliation.summary.issueCount,
      criticalIssueCount: reconciliation.summary.criticalIssueCount,
      issueScopes: [...new Set(reconciliation.issues.map((issue) => issue.scope))],
      requiresManualReview: reconciliation.requiresManualReview,
      brokerSubmissionAllowed: false,
      orderSubmitted: false,
      liveTradingAllowed: false,
    },
  });
}

function notificationEventForReconciliation(
  reconciliation: ReconciliationResult,
  options: {
    requestId: string;
    occurredAt: string;
    auditEventId: string;
  },
): NotificationEvent {
  const scopes = [...new Set(reconciliation.issues.map((issue) => issue.scope))];

  return notificationEventSchema.parse({
    eventId: `notification-reconciliation-${safeIdentifier(reconciliation.reconciliationId)}`,
    occurredAt: options.occurredAt,
    severity: "critical",
    source: {
      type: "broker",
      id: "fake-broker-reconciliation-service",
    },
    target: {
      type: "account",
    },
    summary: `Broker reconciliation ${reconciliation.status}: ${reconciliation.summary.issueCount} issue(s) found.`,
    recommendedAction: "Review reconciliation issues and keep broker delegate disabled until manually resolved.",
    auditEventId: options.auditEventId,
    correlationId: options.requestId,
    dedupeKey: `broker-reconciliation:${reconciliation.accountId}:${reconciliation.status}`,
    cooldownKey: `broker-reconciliation:${reconciliation.accountId}`,
    channels: ["console", "file"],
    metadata: {
      reconciliationId: reconciliation.reconciliationId,
      status: reconciliation.status,
      issueCount: reconciliation.summary.issueCount,
      criticalIssueCount: reconciliation.summary.criticalIssueCount,
      issueScopes: scopes,
      account: maskAccountId(reconciliation.accountId),
      brokerSubmissionAllowed: false,
      orderSubmitted: false,
      liveTradingAllowed: false,
    },
  });
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 96);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
