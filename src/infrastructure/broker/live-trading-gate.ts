import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import type {
  KillSwitchState,
  PolicyCheckResult,
  RiskCheckResult,
} from "../../domain/risk/index.js";
import {
  evaluateLiveTradingGate,
  maskAccountId,
  type LiveAccountAllowlist,
  type LiveBrokerProvider,
  type LiveManualConfirmation,
  type LiveTradingGateResult,
  type LiveTradingMode,
} from "../../domain/trading/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "../storage/atomic-file-writer.js";
import {
  LiveTradingSafetyStore,
  createLiveTradingSafetyPaths,
} from "../storage/index.js";

export interface LiveTradingGateOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
  safetyStore?: Pick<LiveTradingSafetyStore, "readAllowlist" | "readKillSwitch">;
}

export interface EvaluateLiveTradingGateRequest {
  requestedAt?: string;
  liveTradingEnvEnabled?: boolean;
  tradingMode: LiveTradingMode;
  brokerProvider: LiveBrokerProvider;
  accountId: string;
  symbol?: string;
  market?: string;
  manualConfirmation?: LiveManualConfirmation;
  policyResult?: PolicyCheckResult;
  riskResult?: RiskCheckResult;
}

export interface LiveTradingGateAuditResult extends LiveTradingGateResult {
  auditLogPath: string;
  auditBackupPath?: string;
}

export class LiveTradingGate {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly safetyStore: Pick<LiveTradingSafetyStore, "readAllowlist" | "readKillSwitch">;

  constructor(options: LiveTradingGateOptions) {
    this.memoryDir = options.memoryDir;
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.safetyStore = options.safetyStore ?? new LiveTradingSafetyStore({
      memoryDir: options.memoryDir,
      writer: this.writer,
      now: this.now,
      idGenerator: this.idGenerator,
    });
  }

  evaluate(input: EvaluateLiveTradingGateRequest): LiveTradingGateAuditResult {
    const checkedAt = input.requestedAt ?? this.isoNow();
    const allowlist = this.safetyStore.readAllowlist();
    const killSwitchState = this.safetyStore.readKillSwitch();
    const result = evaluateLiveTradingGate({
      requestedAt: checkedAt,
      liveTradingEnvEnabled: input.liveTradingEnvEnabled ?? process.env.LIVE_TRADING === "true",
      tradingMode: input.tradingMode,
      brokerProvider: input.brokerProvider,
      accountId: input.accountId,
      symbol: input.symbol,
      market: input.market,
      manualConfirmation: input.manualConfirmation,
      policyResult: input.policyResult,
      riskResult: input.riskResult,
      allowlist: allowlist as LiveAccountAllowlist | undefined,
      killSwitchState: killSwitchState as KillSwitchState | undefined,
      requestedAction: "submit_order",
      auditWritable: true,
    });
    const paths = createLiveTradingSafetyPaths(this.memoryDir, checkedAt);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForLiveGate({
        eventId: `audit-live-gate-${safeIdentifier(this.idGenerator())}`,
        result,
        accountId: input.accountId,
      }),
      this.writer,
    );

    return {
      ...result,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
    };
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new LiveTradingGateError("LiveTradingGate now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

function auditEventForLiveGate(input: {
  eventId: string;
  result: LiveTradingGateResult;
  accountId: string;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: input.eventId,
    occurredAt: input.result.checkedAt,
    actor: {
      type: "broker",
      id: "live-trading-gate",
    },
    action: "validate",
    subject: {
      type: "risk",
      id: "live-trading-gate",
    },
    severity: input.result.allowed ? "info" : "critical",
    result: input.result.allowed ? "success" : "rejected",
    message: input.result.allowed
      ? "LiveTradingGate passed all live delegate preconditions"
      : "LiveTradingGate rejected live delegate preconditions",
    metadata: {
      decision: input.result.decision,
      allowed: input.result.allowed,
      maskedAccountId: maskAccountId(input.accountId),
      brokerProvider: input.result.brokerProvider,
      tradingMode: input.result.tradingMode,
      requestedAction: input.result.requestedAction,
      liveTradingEnvEnabled: input.result.metadata.liveTradingEnvEnabled,
      hasAllowlist: input.result.metadata.hasAllowlist,
      allowlistMatched: input.result.allowlistEntry !== undefined,
      hasManualConfirmation: input.result.metadata.hasManualConfirmation,
      hasPolicyResult: input.result.metadata.hasPolicyResult,
      hasRiskResult: input.result.metadata.hasRiskResult,
      hasKillSwitchState: input.result.metadata.hasKillSwitchState,
      auditWritable: input.result.metadata.auditWritable,
      reasonCodes: input.result.reasons.map((reason) => reason.code),
      killSwitchMode: input.result.killSwitchResolution?.mode ?? null,
      killSwitchBlockingRuleIds: input.result.killSwitchResolution?.blockingRules.map(
        (rule) => rule.ruleId,
      ) ?? [],
      orderSubmitted: false,
      brokerDelegateCalled: false,
    },
  });
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

export class LiveTradingGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTradingGateError";
  }
}
