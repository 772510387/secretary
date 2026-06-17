import { z } from "zod";
import {
  killSwitchActionSchema,
  resolveKillSwitch,
  type KillSwitchAction,
  type KillSwitchResolution,
  type KillSwitchState,
} from "../risk/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";
import type {
  PolicyCheckResult,
  RiskCheckResult,
} from "../risk/index.js";
import {
  findLiveAccountAllowlistEntry,
  isLiveBrokerProvider,
  liveAccountAllowlistSchema,
  liveBrokerProviderSchema,
  liveTradingModeSchema,
  maskAccountId,
  type LiveAccountAllowlist,
  type LiveAccountAllowlistEntry,
  type LiveBrokerProvider,
  type LiveTradingMode,
} from "./live-account-allowlist.js";

export const liveManualConfirmationSchema = z
  .object({
    approvalId: identifierSchema,
    proposalId: identifierSchema.optional(),
    decision: z.literal("approved"),
    approvedAt: isoDateTimeSchema,
    approvedBy: z
      .object({
        type: z.enum(["user", "system"]),
        id: identifierSchema.optional(),
      })
      .strict(),
    expiresAt: isoDateTimeSchema.optional(),
    revokedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export const liveTradingGateReasonCodeSchema = z.enum([
  "live_env_disabled",
  "trading_mode_not_live",
  "broker_provider_not_live_capable",
  "account_allowlist_missing",
  "account_not_allowlisted",
  "manual_confirmation_missing",
  "manual_confirmation_expired",
  "manual_confirmation_revoked",
  "policy_result_missing",
  "policy_not_passed",
  "risk_result_missing",
  "risk_not_passed",
  "kill_switch_missing",
  "kill_switch_active",
  "audit_not_writable",
]);

export type LiveManualConfirmation = z.infer<typeof liveManualConfirmationSchema>;
export type LiveTradingGateReasonCode = z.infer<typeof liveTradingGateReasonCodeSchema>;
export type LiveTradingGateDecision = "allowed" | "rejected";

export interface LiveTradingGateReason {
  code: LiveTradingGateReasonCode;
  message: string;
  severity: "warning" | "critical";
}

export interface EvaluateLiveTradingGateInput {
  requestedAt: string;
  liveTradingEnvEnabled: boolean;
  tradingMode: LiveTradingMode;
  brokerProvider: LiveBrokerProvider;
  accountId: string;
  symbol?: string;
  market?: string;
  requestedAction?: KillSwitchAction;
  allowlist?: LiveAccountAllowlist;
  manualConfirmation?: LiveManualConfirmation;
  policyResult?: PolicyCheckResult;
  riskResult?: RiskCheckResult;
  killSwitchState?: KillSwitchState;
  auditWritable: boolean;
}

export interface LiveTradingGateResult {
  decision: LiveTradingGateDecision;
  allowed: boolean;
  checkedAt: string;
  maskedAccountId: string;
  tradingMode: LiveTradingMode;
  brokerProvider: LiveBrokerProvider;
  requestedAction: KillSwitchAction;
  reasons: LiveTradingGateReason[];
  allowlistEntry?: LiveAccountAllowlistEntry;
  killSwitchResolution?: KillSwitchResolution;
  metadata: {
    liveTradingEnvEnabled: boolean;
    hasAllowlist: boolean;
    hasManualConfirmation: boolean;
    hasPolicyResult: boolean;
    hasRiskResult: boolean;
    hasKillSwitchState: boolean;
    auditWritable: boolean;
  };
}

type ParsedLiveTradingGateInput = Omit<EvaluateLiveTradingGateInput, "requestedAction"> & {
  requestedAction: KillSwitchAction;
};

export function evaluateLiveTradingGate(
  input: EvaluateLiveTradingGateInput,
): LiveTradingGateResult {
  const parsed = parseGateInput(input);
  const now = new Date(parsed.requestedAt);
  const reasons: LiveTradingGateReason[] = [];

  if (!parsed.liveTradingEnvEnabled) {
    reasons.push(reason("live_env_disabled", "LIVE_TRADING is not explicitly enabled"));
  }

  if (parsed.tradingMode !== "live") {
    reasons.push(reason("trading_mode_not_live", `tradingMode must be live, got ${parsed.tradingMode}`));
  }

  if (!isLiveBrokerProvider(parsed.brokerProvider)) {
    reasons.push(
      reason(
        "broker_provider_not_live_capable",
        `brokerProvider ${parsed.brokerProvider} is not eligible for live gate checks`,
      ),
    );
  }

  const allowlistEntry = parsed.allowlist
    ? findLiveAccountAllowlistEntry({
        allowlist: parsed.allowlist,
        accountId: parsed.accountId,
        brokerProvider: parsed.brokerProvider,
        now,
      })
    : undefined;

  if (!parsed.allowlist) {
    reasons.push(reason("account_allowlist_missing", "Live account allowlist is missing"));
  } else if (!allowlistEntry) {
    reasons.push(
      reason(
        "account_not_allowlisted",
        `Account ${maskAccountId(parsed.accountId)} is not enabled for ${parsed.brokerProvider}`,
      ),
    );
  }

  const manualConfirmation = parsed.manualConfirmation
    ? liveManualConfirmationSchema.parse(parsed.manualConfirmation)
    : undefined;

  if (!manualConfirmation) {
    reasons.push(reason("manual_confirmation_missing", "Manual confirmation is required"));
  } else if (manualConfirmation.revokedAt) {
    reasons.push(
      reason(
        "manual_confirmation_revoked",
        `Manual confirmation ${manualConfirmation.approvalId} was revoked`,
      ),
    );
  } else if (
    manualConfirmation.expiresAt &&
    Date.parse(manualConfirmation.expiresAt) <= now.getTime()
  ) {
    reasons.push(
      reason(
        "manual_confirmation_expired",
        `Manual confirmation ${manualConfirmation.approvalId} expired`,
      ),
    );
  }

  if (!parsed.policyResult) {
    reasons.push(reason("policy_result_missing", "PolicyEngine result is required"));
  } else if (parsed.policyResult.decision !== "passed") {
    reasons.push(reason("policy_not_passed", "PolicyEngine result must be passed"));
  }

  if (!parsed.riskResult) {
    reasons.push(reason("risk_result_missing", "RiskEngine result is required"));
  } else if (parsed.riskResult.decision !== "passed") {
    reasons.push(reason("risk_not_passed", "RiskEngine result must be passed"));
  }

  const killSwitchResolution = parsed.killSwitchState
    ? resolveKillSwitch({
        state: parsed.killSwitchState,
        accountId: parsed.accountId,
        symbol: parsed.symbol,
        market: parsed.market,
        action: parsed.requestedAction,
        now,
      })
    : undefined;

  if (!parsed.killSwitchState) {
    reasons.push(reason("kill_switch_missing", "Kill switch state is missing"));
  } else if (killSwitchResolution?.blocking) {
    reasons.push(
      reason(
        "kill_switch_active",
        killSwitchResolution.blockingReason ?? "Kill switch blocks this live action",
      ),
    );
  }

  if (!parsed.auditWritable) {
    reasons.push(reason("audit_not_writable", "Audit log must be writable before live delegate"));
  }

  const allowed = reasons.length === 0;

  return {
    decision: allowed ? "allowed" : "rejected",
    allowed,
    checkedAt: parsed.requestedAt,
    maskedAccountId: maskAccountId(parsed.accountId),
    tradingMode: parsed.tradingMode,
    brokerProvider: parsed.brokerProvider,
    requestedAction: parsed.requestedAction,
    reasons,
    allowlistEntry,
    killSwitchResolution,
    metadata: {
      liveTradingEnvEnabled: parsed.liveTradingEnvEnabled,
      hasAllowlist: parsed.allowlist !== undefined,
      hasManualConfirmation: manualConfirmation !== undefined,
      hasPolicyResult: parsed.policyResult !== undefined,
      hasRiskResult: parsed.riskResult !== undefined,
      hasKillSwitchState: parsed.killSwitchState !== undefined,
      auditWritable: parsed.auditWritable,
    },
  };
}

function parseGateInput(input: EvaluateLiveTradingGateInput): ParsedLiveTradingGateInput {
  return {
    requestedAt: isoDateTimeSchema.parse(input.requestedAt),
    liveTradingEnvEnabled: z.boolean().parse(input.liveTradingEnvEnabled),
    tradingMode: liveTradingModeSchema.parse(input.tradingMode),
    brokerProvider: liveBrokerProviderSchema.parse(input.brokerProvider),
    accountId: identifierSchema.parse(input.accountId),
    symbol: input.symbol === undefined ? undefined : stockSymbolSchema.parse(input.symbol),
    market: input.market === undefined ? undefined : stockMarketSchema.parse(input.market),
    requestedAction: killSwitchActionSchema.parse(input.requestedAction ?? "submit_order"),
    allowlist: input.allowlist === undefined
      ? undefined
      : liveAccountAllowlistSchema.parse(input.allowlist),
    manualConfirmation: input.manualConfirmation === undefined
      ? undefined
      : liveManualConfirmationSchema.parse(input.manualConfirmation),
    policyResult: input.policyResult,
    riskResult: input.riskResult,
    killSwitchState: input.killSwitchState,
    auditWritable: z.boolean().parse(input.auditWritable),
  };
}

function reason(
  code: LiveTradingGateReasonCode,
  message: string,
): LiveTradingGateReason {
  return {
    code,
    message,
    severity: code === "audit_not_writable" || code === "kill_switch_active"
      ? "critical"
      : "warning",
  };
}
