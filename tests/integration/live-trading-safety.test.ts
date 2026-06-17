import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  type PolicyCheckResult,
  type RiskCheckResult,
} from "../../src/domain/risk/index.js";
import {
  LiveTradingGate,
} from "../../src/infrastructure/broker/index.js";
import {
  LiveTradingSafetyStore,
  createLiveTradingSafetyPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";
const accountId = "live-account-001";

describe("LiveTradingSafetyStore and LiveTradingGate", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("persists allowlist and clear kill switch, then passes a fake-live gate without broker delegate", () => {
    const memoryDir = createTempMemoryDir();
    const store = createStore(memoryDir);
    const paths = createLiveTradingSafetyPaths(memoryDir, now);

    const allowlistWrite = store.writeAllowlist({
      allowlistId: "live-account-allowlist",
      updatedAt: now,
      entries: [
        {
          accountId,
          brokerProvider: "fake_live",
          tradingMode: "live",
          status: "enabled",
          reason: "integration test fake live account",
          createdAt: now,
          updatedAt: now,
          metadata: {},
        },
      ],
      metadata: {
        seededBy: "test",
      },
    });
    const killSwitchWrite = store.writeKillSwitch({
      stateId: "kill-switch-state",
      updatedAt: now,
      rules: [],
      metadata: {
        state: "clear",
      },
    });
    const gate = createGate(memoryDir);
    const result = gate.evaluate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      symbol: "000001",
      market: "SZSE",
      manualConfirmation: makeManualConfirmation(),
      policyResult: policyPassed,
      riskResult: riskPassed,
    });

    expect(allowlistWrite.filePath).toBe(paths.allowlistPath);
    expect(killSwitchWrite.filePath).toBe(paths.killSwitchPath);
    expect(result).toMatchObject({
      allowed: true,
      decision: "allowed",
      auditLogPath: paths.auditLogPath,
      metadata: {
        hasAllowlist: true,
        hasKillSwitchState: true,
      },
    });
    expect(existsSync(paths.allowlistPath)).toBe(true);
    expect(existsSync(paths.killSwitchPath)).toBe(true);
    expect(existsSync(path.join(memoryDir, "portfolio", "orders.jsonl"))).toBe(false);
    expect(existsSync(path.join(memoryDir, "portfolio", "trades.jsonl"))).toBe(false);

    const auditText = readFileSync(paths.auditLogPath, "utf8");
    expect(auditText).not.toContain(accountId);
    expect(auditText).toContain("liv***-001");

    const gateAudit = lastAuditByActor(paths.auditLogPath, "live-trading-gate");
    expect(gateAudit).toMatchObject({
      action: "validate",
      result: "success",
      metadata: {
        allowed: true,
        maskedAccountId: "liv***-001",
        brokerDelegateCalled: false,
        orderSubmitted: false,
        reasonCodes: [],
      },
    });
  });

  it("defaults to reject when allowlist is missing and writes metadata-only audit", () => {
    const memoryDir = createTempMemoryDir();
    const gate = createGate(memoryDir);
    const result = gate.evaluate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      manualConfirmation: makeManualConfirmation(),
      policyResult: policyPassed,
      riskResult: riskPassed,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      "account_allowlist_missing",
      "kill_switch_missing",
    ]);

    const audit = lastAuditByActor(result.auditLogPath, "live-trading-gate");
    expect(audit).toMatchObject({
      result: "rejected",
      metadata: {
        hasAllowlist: false,
        hasKillSwitchState: false,
        reasonCodes: ["account_allowlist_missing", "kill_switch_missing"],
        brokerDelegateCalled: false,
        orderSubmitted: false,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(accountId);
  });

  it("persists an active kill switch and blocks live gate handoff", () => {
    const memoryDir = createTempMemoryDir();
    const store = createStore(memoryDir);

    store.writeAllowlist({
      allowlistId: "live-account-allowlist",
      updatedAt: now,
      entries: [
        {
          accountId,
          brokerProvider: "fake_live",
          tradingMode: "live",
          status: "enabled",
          reason: "integration test fake live account",
          createdAt: now,
          updatedAt: now,
          metadata: {},
        },
      ],
      metadata: {},
    });
    store.writeKillSwitch({
      stateId: "kill-switch-state",
      updatedAt: now,
      rules: [
        {
          ruleId: "global-disabled",
          scope: "global",
          mode: "disabled",
          reason: "emergency stop",
          updatedAt: now,
          updatedBy: {
            type: "system",
            id: "test",
          },
          metadata: {},
        },
      ],
      metadata: {},
    });

    const result = createGate(memoryDir).evaluate({
      requestedAt: now,
      liveTradingEnvEnabled: true,
      tradingMode: "live",
      brokerProvider: "fake_live",
      accountId,
      symbol: "000001",
      market: "SZSE",
      manualConfirmation: makeManualConfirmation(),
      policyResult: policyPassed,
      riskResult: riskPassed,
    });

    expect(result.allowed).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual(["kill_switch_active"]);

    const audit = lastAuditByActor(result.auditLogPath, "live-trading-gate");
    expect(audit).toMatchObject({
      result: "rejected",
      metadata: {
        reasonCodes: ["kill_switch_active"],
        killSwitchMode: "disabled",
        killSwitchBlockingRuleIds: ["global-disabled"],
        brokerDelegateCalled: false,
        orderSubmitted: false,
      },
    });
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

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-live-trading-safety-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function createStore(memoryDir: string): LiveTradingSafetyStore {
  return new LiveTradingSafetyStore({
    memoryDir,
    now: () => new Date(now),
    idGenerator: createIdGenerator(),
  });
}

function createGate(memoryDir: string): LiveTradingGate {
  return new LiveTradingGate({
    memoryDir,
    now: () => new Date(now),
    idGenerator: createIdGenerator(),
  });
}

function makeManualConfirmation() {
  return {
    approvalId: "approval-live-001",
    proposalId: "proposal-live-001",
    decision: "approved" as const,
    approvedAt: now,
    approvedBy: {
      type: "user" as const,
      id: "operator-001",
    },
  };
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `live-${String(id).padStart(3, "0")}`;
  };
}

function readAuditEvents(filePath: string) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => auditEventSchema.parse(JSON.parse(line)));
}

function lastAuditByActor(filePath: string, actorId: string) {
  const events = readAuditEvents(filePath).filter((event) => event.actor.id === actorId);

  expect(events.length).toBeGreaterThan(0);
  return events.at(-1)!;
}
