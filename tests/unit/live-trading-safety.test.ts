import { describe, expect, it } from "vitest";
import {
  killSwitchStateSchema,
  resolveKillSwitch,
  type KillSwitchState,
  type PolicyCheckResult,
  type RiskCheckResult,
} from "../../src/domain/risk/index.js";
import {
  evaluateLiveTradingGate,
  findLiveAccountAllowlistEntry,
  liveAccountAllowlistEntrySchema,
  maskAccountId,
  type LiveAccountAllowlist,
  type LiveManualConfirmation,
} from "../../src/domain/trading/index.js";

const now = "2026-06-16T01:30:00.000Z";
const accountId = "live-account-001";

describe("live account allowlist", () => {
  it("rejects wildcard account identifiers and masks display identifiers", () => {
    expect(() =>
      liveAccountAllowlistEntrySchema.parse({
        accountId: "all",
        brokerProvider: "fake_live",
        tradingMode: "live",
        status: "enabled",
        reason: "invalid wildcard",
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow(/wildcard/);

    expect(maskAccountId(accountId)).toBe("liv***-001");
    expect(maskAccountId("abc")).toBe("***");
  });

  it("defaults to deny when allowlist is missing or an entry is disabled or expired", () => {
    expect(
      findLiveAccountAllowlistEntry({
        allowlist: undefined,
        accountId,
        brokerProvider: "fake_live",
        now: new Date(now),
      }),
    ).toBeUndefined();

    const allowlist = makeAllowlist({
      status: "disabled",
      expiresAt: undefined,
    });

    expect(
      findLiveAccountAllowlistEntry({
        allowlist,
        accountId,
        brokerProvider: "fake_live",
        now: new Date(now),
      }),
    ).toBeUndefined();

    const expired = makeAllowlist({
      status: "enabled",
      expiresAt: "2026-06-16T01:29:00.000Z",
    });

    expect(
      findLiveAccountAllowlistEntry({
        allowlist: expired,
        accountId,
        brokerProvider: "fake_live",
        now: new Date(now),
      }),
    ).toBeUndefined();
  });
});

describe("kill switch state", () => {
  it("supports global, account, and symbol scopes with readOnly, cancelOnly, and disabled modes", () => {
    const state = killSwitchStateSchema.parse({
      stateId: "kill-switch-state",
      updatedAt: now,
      rules: [
        makeKillRule({ ruleId: "global-cancel", scope: "global", mode: "cancelOnly" }),
        makeKillRule({
          ruleId: "account-disabled",
          scope: "account",
          mode: "disabled",
          accountId: "other-live-account",
        }),
        makeKillRule({
          ruleId: "symbol-readonly",
          scope: "symbol",
          mode: "readOnly",
          symbol: "000001",
          market: "SZSE",
        }),
      ],
    });

    expect(
      resolveKillSwitch({
        state,
        accountId,
        action: "submit_order",
        now: new Date(now),
      }),
    ).toMatchObject({
      mode: "cancelOnly",
      blocking: true,
      blockingRules: [expect.objectContaining({ ruleId: "global-cancel" })],
    });

    expect(
      resolveKillSwitch({
        state,
        accountId,
        action: "cancel_order",
        now: new Date(now),
      }).blocking,
    ).toBe(false);

    expect(
      resolveKillSwitch({
        state,
        accountId: "other-live-account",
        action: "cancel_order",
        now: new Date(now),
      }),
    ).toMatchObject({
      mode: "disabled",
      blocking: true,
      blockingRules: [expect.objectContaining({ ruleId: "account-disabled" })],
    });

    const symbolResolution = resolveKillSwitch({
      state,
      accountId,
      symbol: "000001",
      market: "SZSE",
      action: "submit_order",
      now: new Date(now),
    });

    expect(symbolResolution).toMatchObject({
      mode: "readOnly",
      blocking: true,
    });
    expect(symbolResolution.blockingRules.map((rule) => rule.ruleId)).toEqual([
      "global-cancel",
      "symbol-readonly",
    ]);
  });
});

describe("LiveTradingGate", () => {
  it("does not pass just because LIVE_TRADING is true", () => {
    const result = evaluateLiveTradingGate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "paper",
      brokerProvider: "paper",
      accountId,
      auditWritable: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "trading_mode_not_live",
      "broker_provider_not_live_capable",
      "account_allowlist_missing",
      "manual_confirmation_missing",
      "policy_result_missing",
      "risk_result_missing",
      "kill_switch_missing",
      "audit_not_writable",
    ]);
  });

  it("passes only when allowlist, manual confirmation, policy, risk, kill switch, and audit checks pass", () => {
    const result = evaluateLiveTradingGate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      symbol: "000001",
      market: "SZSE",
      allowlist: makeAllowlist(),
      manualConfirmation: makeManualConfirmation(),
      policyResult: policyPassed,
      riskResult: riskPassed,
      killSwitchState: makeKillSwitchState(),
      auditWritable: true,
    });

    expect(result).toMatchObject({
      allowed: true,
      decision: "allowed",
      maskedAccountId: "liv***-001",
      reasons: [],
      metadata: {
        liveTradingEnvEnabled: true,
        hasAllowlist: true,
        hasManualConfirmation: true,
        hasPolicyResult: true,
        hasRiskResult: true,
        hasKillSwitchState: true,
        auditWritable: true,
      },
    });
    expect(result.allowlistEntry).toMatchObject({
      accountId,
      brokerProvider: "fake_live",
    });
  });

  it("rejects failed policy, failed risk, expired confirmation, or active kill switch", () => {
    const result = evaluateLiveTradingGate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      symbol: "000001",
      market: "SZSE",
      allowlist: makeAllowlist(),
      manualConfirmation: {
        ...makeManualConfirmation(),
        expiresAt: "2026-06-16T01:29:00.000Z",
      },
      policyResult: {
        decision: "rejected",
        reason: {
          code: "non_main_board",
          message: "mock rejection",
        },
      },
      riskResult: {
        ...riskPassed,
        decision: "warning",
        severity: "critical",
        requiresManualConfirmation: true,
      },
      killSwitchState: makeKillSwitchState([
        makeKillRule({ ruleId: "global-disabled", scope: "global", mode: "disabled" }),
      ]),
      auditWritable: true,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "manual_confirmation_expired",
      "policy_not_passed",
      "risk_not_passed",
      "kill_switch_active",
    ]);
  });
});

const policyPassed: PolicyCheckResult = {
  decision: "passed",
};

const riskPassed: RiskCheckResult = {
  decision: "passed",
  severity: "info",
  violations: [],
  blockingViolations: [],
  requiresManualConfirmation: false,
};

function makeAllowlist(
  entryOverrides: Partial<LiveAccountAllowlist["entries"][number]> = {},
): LiveAccountAllowlist {
  return {
    allowlistId: "live-account-allowlist",
    updatedAt: now,
    entries: [
      {
        accountId,
        brokerProvider: "fake_live",
        tradingMode: "live",
        status: "enabled",
        reason: "fake live account for contract tests",
        createdAt: now,
        updatedAt: now,
        metadata: {},
        ...entryOverrides,
      },
    ],
    metadata: {},
  };
}

function makeManualConfirmation(): LiveManualConfirmation {
  return {
    approvalId: "approval-live-001",
    proposalId: "proposal-live-001",
    decision: "approved",
    approvedAt: now,
    approvedBy: {
      type: "user",
      id: "operator-001",
    },
  };
}

function makeKillSwitchState(rules: KillSwitchState["rules"] = []): KillSwitchState {
  return killSwitchStateSchema.parse({
    stateId: "kill-switch-state",
    updatedAt: now,
    rules,
    metadata: {},
  });
}

function makeKillRule(
  overrides: Partial<KillSwitchState["rules"][number]>,
): KillSwitchState["rules"][number] {
  return {
    ruleId: "kill-rule",
    scope: "global",
    mode: "clear",
    reason: "test rule",
    updatedAt: now,
    updatedBy: {
      type: "system",
      id: "test",
    },
    metadata: {},
    ...overrides,
  } as KillSwitchState["rules"][number];
}
