import {
  accountSchema,
  type Account,
  type Position,
} from "../domain/portfolio/index.js";
import { auditEventSchema, type AuditEvent } from "../domain/audit/index.js";

export class PaperAccountInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperAccountInitializationError";
  }
}

export interface BuildInitialPaperAccountSeedOptions {
  accountId?: string;
  initialCash?: number;
  now?: Date | string;
  actorId?: string;
}

export interface PaperAccountSeed {
  account: Account;
  positions: Position[];
  tradesJsonl: string;
  auditEvent: AuditEvent;
}

export interface ExistingPaperAccountFiles {
  account?: boolean;
  positions?: boolean;
  trades?: boolean;
}

export function buildInitialPaperAccountSeed(
  options: BuildInitialPaperAccountSeedOptions = {},
): PaperAccountSeed {
  const accountId = options.accountId ?? "paper-main";
  const initialCash = options.initialCash ?? 20000;
  const now = normalizeDate(options.now);
  const nowIso = now.toISOString();

  const account = accountSchema.parse({
    accountId,
    type: "paper",
    baseCurrency: "CNY",
    initialCash,
    cash: {
      available: initialCash,
      frozen: 0,
    },
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const auditEvent = auditEventSchema.parse({
    eventId: `audit-${nowIso}`,
    occurredAt: nowIso,
    actor: {
      type: "system",
      id: options.actorId ?? "seed-paper-account",
    },
    action: "write",
    subject: {
      type: "account",
      id: accountId,
    },
    severity: "info",
    result: "success",
    message: "Initialized paper trading account",
    metadata: {
      accountId,
      initialCash,
      baseCurrency: "CNY",
      liveTrading: false,
    },
  });

  return {
    account,
    positions: [],
    tradesJsonl: "",
    auditEvent,
  };
}

export function assertCanInitializePaperAccount(
  existingFiles: ExistingPaperAccountFiles,
  options: { reset?: boolean } = {},
): void {
  const existing = Object.entries(existingFiles)
    .filter(([, exists]) => exists)
    .map(([name]) => name);

  if (existing.length > 0 && options.reset !== true) {
    throw new PaperAccountInitializationError(
      `Paper account memory already exists: ${existing.join(
        ", ",
      )}. Pass --reset to overwrite.`,
    );
  }
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new PaperAccountInitializationError(`Invalid initialization date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

