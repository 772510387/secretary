import {
  killSwitchStateSchema,
  type KillSwitchMode,
  type KillSwitchState,
} from "../../domain/risk/index.js";
import {
  maskAccountId,
  type ReconciliationResult,
} from "../../domain/trading/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain/shared/index.js";
import {
  LiveTradingSafetyStore,
  type LiveTradingSafetyWriteResult,
} from "../storage/index.js";

export interface ApplyReconciliationFailureDowngradeOptions {
  memoryDir: string;
  result: ReconciliationResult;
  mode?: Extract<KillSwitchMode, "readOnly" | "cancelOnly">;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ClearReconciliationFailureDowngradeOptions {
  memoryDir: string;
  accountId: string;
  reconciliationId?: string;
  clearedBy: {
    type: "user" | "system";
    id?: string;
  };
  reason: string;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface ReconciliationDowngradeResult {
  applied: boolean;
  ruleId?: string;
  state?: KillSwitchState;
  write?: LiveTradingSafetyWriteResult<KillSwitchState>;
  metadata: {
    reason: string;
    requiresManualClear: boolean;
    brokerSubmissionAllowed: false;
  };
}

export function applyReconciliationFailureDowngrade(
  options: ApplyReconciliationFailureDowngradeOptions,
): ReconciliationDowngradeResult {
  if (options.result.status === "matched") {
    return {
      applied: false,
      metadata: {
        reason: "reconciliation_matched",
        requiresManualClear: false,
        brokerSubmissionAllowed: false,
      },
    };
  }

  const now = normalizeNow(options.now).toISOString();
  const mode = options.mode ?? "readOnly";
  const store = createSafetyStore(options);
  const existing = store.readKillSwitch();
  const ruleId = `reconciliation-${safeIdentifier(options.result.reconciliationId)}`;
  const nextState = killSwitchStateSchema.parse({
    stateId: existing?.stateId ?? "kill-switch-state",
    updatedAt: now,
    rules: [
      ...(existing?.rules.filter((rule) => rule.ruleId !== ruleId) ?? []),
      {
        ruleId,
        scope: "account",
        mode,
        accountId: options.result.accountId,
        reason: `Reconciliation ${options.result.reconciliationId} ended with ${options.result.status}`,
        updatedAt: now,
        updatedBy: {
          type: "system",
          id: "reconciliation-downgrade",
        },
        metadata: {
          reconciliationId: options.result.reconciliationId,
          status: options.result.status,
          issueCount: options.result.summary.issueCount,
          criticalIssueCount: options.result.summary.criticalIssueCount,
          issueScopes: [...new Set(options.result.issues.map((issue) => issue.scope))],
          maskedAccountId: maskAccountId(options.result.accountId),
          requiresManualClear: true,
          brokerSubmissionAllowed: false,
          orderSubmitted: false,
        },
      },
    ],
    metadata: {
      ...asRecord(existing?.metadata),
      lastReconciliationDowngradeAt: now,
      lastReconciliationId: options.result.reconciliationId,
    },
  });
  const write = store.writeKillSwitch(nextState);

  return {
    applied: true,
    ruleId,
    state: write.value,
    write,
    metadata: {
      reason: "reconciliation_not_matched",
      requiresManualClear: true,
      brokerSubmissionAllowed: false,
    },
  };
}

export function clearReconciliationFailureDowngrade(
  options: ClearReconciliationFailureDowngradeOptions,
): ReconciliationDowngradeResult {
  const accountId = identifierSchema.parse(options.accountId);
  const now = normalizeNow(options.now).toISOString();
  const store = createSafetyStore(options);
  const existing = store.readKillSwitch();
  const targetRuleIds = existing?.rules
    .filter((rule) =>
      rule.scope === "account" &&
      rule.accountId === accountId &&
      rule.metadata &&
      typeof rule.metadata === "object" &&
      !Array.isArray(rule.metadata) &&
      (options.reconciliationId === undefined ||
        (rule.metadata as Record<string, unknown>).reconciliationId === options.reconciliationId)
    )
    .map((rule) => rule.ruleId) ?? [];
  const clearRuleId = `clear-reconciliation-${safeIdentifier(options.reconciliationId ?? accountId)}`;
  const nextState = killSwitchStateSchema.parse({
    stateId: existing?.stateId ?? "kill-switch-state",
    updatedAt: now,
    rules: [
      ...(existing?.rules.filter((rule) => !targetRuleIds.includes(rule.ruleId)) ?? []),
      {
        ruleId: clearRuleId,
        scope: "account",
        mode: "clear",
        accountId,
        reason: options.reason,
        updatedAt: now,
        updatedBy: {
          type: options.clearedBy.type,
          id: options.clearedBy.id ? identifierSchema.parse(options.clearedBy.id) : undefined,
        },
        metadata: {
          reconciliationId: options.reconciliationId ?? null,
          clearedRuleIds: targetRuleIds,
          maskedAccountId: maskAccountId(accountId),
          manualClear: options.clearedBy.type === "user",
          brokerSubmissionAllowed: false,
        },
      },
    ],
    metadata: {
      ...asRecord(existing?.metadata),
      lastReconciliationClearAt: now,
      lastReconciliationClearBy: options.clearedBy.id ?? options.clearedBy.type,
    },
  });
  const write = store.writeKillSwitch(nextState);

  return {
    applied: true,
    ruleId: clearRuleId,
    state: write.value,
    write,
    metadata: {
      reason: "reconciliation_downgrade_cleared",
      requiresManualClear: false,
      brokerSubmissionAllowed: false,
    },
  };
}

function createSafetyStore(options: {
  memoryDir: string;
  now?: () => Date;
  idGenerator?: () => string;
}): LiveTradingSafetyStore {
  return new LiveTradingSafetyStore({
    memoryDir: options.memoryDir,
    now: options.now,
    idGenerator: options.idGenerator,
  });
}

function normalizeNow(now: (() => Date) | undefined): Date {
  const value = now ? now() : new Date();

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("Reconciliation downgrade now() returned an invalid Date");
  }

  isoDateTimeSchema.parse(value.toISOString());
  return value;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 80);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
