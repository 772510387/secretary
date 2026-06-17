import path from "node:path";
import { z } from "zod";
import type { AuditSubjectType } from "../../domain/audit/index.js";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../domain/portfolio/index.js";
import {
  executionReportSchema,
  orderSchema,
  type ExecutionReport,
  type Order,
} from "../../domain/trading/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain/shared/index.js";
import { maskAccountId } from "../../domain/trading/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "../storage/index.js";

export interface ReadOnlyBrokerReadRequest {
  requestId: string;
  accountId: string;
  requestedAt?: string;
}

export interface ReadOnlyBroker {
  getAccountSnapshot(request: ReadOnlyBrokerReadRequest): Promise<Account>;
  getCash(request: ReadOnlyBrokerReadRequest): Promise<Account["cash"]>;
  getPositions(request: ReadOnlyBrokerReadRequest): Promise<Position[]>;
  getOrders(request: ReadOnlyBrokerReadRequest): Promise<Order[]>;
  getExecutions(request: ReadOnlyBrokerReadRequest): Promise<ExecutionReport[]>;
}

export interface FakeReadOnlyBrokerOptions {
  memoryDir: string;
  account?: Account;
  positions?: Position[];
  orders?: Order[];
  executions?: ExecutionReport[];
  now?: () => Date;
  idGenerator?: () => string;
  writer?: AtomicFileWriter;
}

export class FakeReadOnlyBroker implements ReadOnlyBroker {
  private readonly memoryDir: string;
  private readonly account: Account;
  private readonly positions: Position[];
  private readonly orders: Order[];
  private readonly executions: ExecutionReport[];
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly writer: AtomicFileWriter;

  constructor(options: FakeReadOnlyBrokerOptions) {
    const now = options.now ?? (() => new Date());

    this.memoryDir = path.resolve(options.memoryDir);
    this.account = accountSchema.parse(options.account ?? defaultReadOnlyAccount(now()));
    this.positions = z.array(positionSchema).parse(options.positions ?? []);
    this.orders = z.array(orderSchema).parse(options.orders ?? []);
    this.executions = z.array(executionReportSchema).parse(options.executions ?? []);
    this.now = now;
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.writer = options.writer ?? new AtomicFileWriter();
  }

  async getAccountSnapshot(request: ReadOnlyBrokerReadRequest): Promise<Account> {
    const parsed = parseReadRequest(request);
    this.auditRead(parsed, {
      subjectType: "account",
      subjectId: "account-snapshot",
      recordCount: 1,
    });

    return accountSchema.parse(this.account);
  }

  async getCash(request: ReadOnlyBrokerReadRequest): Promise<Account["cash"]> {
    const parsed = parseReadRequest(request);
    this.auditRead(parsed, {
      subjectType: "account",
      subjectId: "cash",
      recordCount: 1,
    });

    return accountSchema.parse(this.account).cash;
  }

  async getPositions(request: ReadOnlyBrokerReadRequest): Promise<Position[]> {
    const parsed = parseReadRequest(request);
    this.auditRead(parsed, {
      subjectType: "position",
      subjectId: "positions",
      recordCount: this.positions.length,
    });

    return z.array(positionSchema).parse(this.positions);
  }

  async getOrders(request: ReadOnlyBrokerReadRequest): Promise<Order[]> {
    const parsed = parseReadRequest(request);
    this.auditRead(parsed, {
      subjectType: "order",
      subjectId: "orders",
      recordCount: this.orders.length,
    });

    return z.array(orderSchema).parse(this.orders);
  }

  async getExecutions(request: ReadOnlyBrokerReadRequest): Promise<ExecutionReport[]> {
    const parsed = parseReadRequest(request);
    this.auditRead(parsed, {
      subjectType: "trade",
      subjectId: "executions",
      recordCount: this.executions.length,
    });

    return z.array(executionReportSchema).parse(this.executions);
  }

  auditLogPath(occurredAt: string = this.now().toISOString()): string {
    return createReadOnlyBrokerAuditLogPath(this.memoryDir, occurredAt);
  }

  private auditRead(
    request: ParsedReadOnlyBrokerReadRequest,
    options: {
      subjectType: AuditSubjectType;
      subjectId: string;
      recordCount: number;
    },
  ): void {
    const occurredAt = this.now().toISOString();
    const event = auditEventSchema.parse({
      eventId: `audit-read-only-broker-${safeIdentifier(this.idGenerator())}`,
      occurredAt,
      actor: {
        type: "broker",
        id: "fake-read-only-broker",
      },
      action: "read",
      subject: {
        type: options.subjectType,
        id: options.subjectId,
      },
      severity: "info",
      result: "success",
      message: `Read-only broker ${options.subjectId} query`,
      correlationId: request.requestId,
      metadata: {
        requestId: request.requestId,
        requestedAt: request.requestedAt ?? null,
        maskedAccountId: maskAccountId(request.accountId),
        recordCount: options.recordCount,
        brokerConnected: false,
        liveBrokerCalled: false,
        submitOrderAvailable: false,
        cancelOrderAvailable: false,
        containsRealAccountSecret: false,
      },
    } satisfies AuditEvent);

    appendAuditEvent(this.auditLogPath(occurredAt), event, this.writer);
  }
}

export function createReadOnlyBrokerAuditLogPath(
  memoryDir: string,
  occurredAt: string = new Date().toISOString(),
): string {
  return path.join(path.resolve(memoryDir), "logs", `audit-${occurredAt.slice(0, 10)}.jsonl`);
}

interface ParsedReadOnlyBrokerReadRequest extends ReadOnlyBrokerReadRequest {
  requestedAt?: string;
}

function parseReadRequest(
  request: ReadOnlyBrokerReadRequest,
): ParsedReadOnlyBrokerReadRequest {
  return {
    requestId: identifierSchema.parse(request.requestId),
    accountId: identifierSchema.parse(request.accountId),
    requestedAt: request.requestedAt === undefined
      ? undefined
      : isoDateTimeSchema.parse(request.requestedAt),
  };
}

function defaultReadOnlyAccount(now: Date): Account {
  const iso = now.toISOString();

  return accountSchema.parse({
    accountId: "fake-read-only-account",
    type: "live",
    baseCurrency: "CNY",
    initialCash: 0,
    cash: {
      available: 0,
      frozen: 0,
    },
    status: "active",
    createdAt: iso,
    updatedAt: iso,
  });
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}
