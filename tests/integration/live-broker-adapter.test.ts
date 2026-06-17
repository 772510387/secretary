import { describe, expect, it } from "vitest";
import {
  type KillSwitchState,
  type PolicyCheckResult,
  type RiskCheckResult,
  killSwitchStateSchema,
} from "../../src/domain/risk/index.js";
import {
  evaluateLiveTradingGate,
  tradeIntentSchema,
  type LiveManualConfirmation,
  type LiveTradingGateResult,
  type TradeIntent,
} from "../../src/domain/trading/index.js";
import {
  FakeLiveBrokerAdapter,
  LiveBrokerAdapterError,
} from "../../src/infrastructure/broker/index.js";

const now = "2026-06-16T01:30:00.000Z";
const accountId = "live-account-001";

describe("LiveBrokerAdapter contract with FakeLiveBrokerAdapter", () => {
  it("covers read queries and accepts a submit only with an allowed LiveTradingGateResult", async () => {
    const broker = createBroker();
    const gateResult = makeAllowedGate();
    const submit = await broker.submitOrder({
      requestId: "submit-001",
      intent: makeIntent(),
      gateResult,
      requestedAt: now,
    });
    const duplicate = await broker.submitOrder({
      requestId: "submit-001",
      intent: makeIntent({ intentId: "intent-ignored-duplicate" }),
      gateResult,
      requestedAt: now,
    });

    expect(await broker.getAccountSnapshot(makeReadRequest())).toMatchObject({
      accountId: "fake-live-account",
      type: "live",
    });
    expect(await broker.getCash(makeReadRequest("read-cash"))).toEqual({
      available: 0,
      frozen: 0,
    });
    expect(await broker.getPositions(makeReadRequest("read-positions"))).toEqual([]);
    expect(submit).toMatchObject({
      status: "accepted",
      duplicate: false,
      brokerOrderId: "live-order-0001",
      order: {
        status: "submitted",
        intentId: "intent-live-buy",
      },
      metadata: {
        provider: "fake_live",
        gateAllowed: true,
        brokerConnected: false,
        liveBrokerCalled: true,
        orderSubmitted: true,
      },
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      brokerOrderId: submit.brokerOrderId,
      order: {
        intentId: "intent-live-buy",
      },
    });
    expect(await broker.getOrders(makeReadRequest("read-orders"))).toHaveLength(1);
    expect(await broker.getExecutions(makeReadRequest("read-executions"))).toEqual([]);
  });

  it("rejects submit before fake broker call when LiveTradingGateResult is rejected", async () => {
    const broker = createBroker();
    const result = await broker.submitOrder({
      requestId: "submit-gate-rejected",
      intent: makeIntent(),
      gateResult: makeRejectedGate(),
      requestedAt: now,
    });

    expect(result).toMatchObject({
      status: "rejected",
      rejection: {
        code: "live_gate_rejected",
      },
      metadata: {
        gateAllowed: false,
        liveBrokerCalled: false,
        orderSubmitted: false,
      },
    });
    expect(await broker.getOrders(makeReadRequest("read-after-reject"))).toEqual([]);
  });

  it("covers fake broker reject, unknown, and timeout submit outcomes", async () => {
    const rejected = await createBroker({ submitBehavior: "reject" }).submitOrder({
      requestId: "submit-reject",
      intent: makeIntent(),
      gateResult: makeAllowedGate(),
      requestedAt: now,
    });
    const unknown = await createBroker({ submitBehavior: "unknown" }).submitOrder({
      requestId: "submit-unknown",
      intent: makeIntent(),
      gateResult: makeAllowedGate(),
      requestedAt: now,
    });

    await expect(
      createBroker({ submitBehavior: "timeout" }).submitOrder({
        requestId: "submit-timeout",
        intent: makeIntent(),
        gateResult: makeAllowedGate(),
        requestedAt: now,
      }),
    ).rejects.toMatchObject({
      name: "LiveBrokerAdapterError",
      code: "timeout",
    } satisfies Partial<LiveBrokerAdapterError>);

    expect(rejected).toMatchObject({
      status: "rejected",
      order: {
        status: "rejected",
      },
      rejection: {
        code: "broker_rejected",
      },
      metadata: {
        orderSubmitted: false,
      },
    });
    expect(unknown).toMatchObject({
      status: "unknown",
      order: {
        status: "submitted",
      },
      rejection: {
        code: "broker_status_unknown",
      },
      metadata: {
        orderSubmitted: false,
      },
    });
  });

  it("cancels submitted fake orders with gate result and handles duplicate cancel requests", async () => {
    const broker = createBroker();
    const gateResult = makeAllowedGate("cancel_order");
    const submit = await broker.submitOrder({
      requestId: "submit-cancel-target",
      intent: makeIntent(),
      gateResult: makeAllowedGate(),
      requestedAt: now,
    });

    const cancel = await broker.cancelOrder({
      requestId: "cancel-001",
      accountId,
      brokerOrderId: submit.brokerOrderId!,
      gateResult,
      requestedAt: now,
    });
    const duplicate = await broker.cancelOrder({
      requestId: "cancel-001",
      accountId,
      brokerOrderId: submit.brokerOrderId!,
      gateResult,
      requestedAt: now,
    });

    expect(cancel).toMatchObject({
      status: "cancelled",
      duplicate: false,
      brokerOrderId: submit.brokerOrderId,
      order: {
        status: "cancelled",
      },
      metadata: {
        gateAllowed: true,
        orderCancelled: true,
      },
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      status: "cancelled",
      brokerOrderId: submit.brokerOrderId,
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

function createBroker(
  options: {
    submitBehavior?: "success" | "reject" | "unknown" | "timeout";
    cancelBehavior?: "success" | "reject" | "unknown" | "timeout";
  } = {},
): FakeLiveBrokerAdapter {
  let id = 0;

  return new FakeLiveBrokerAdapter({
    ...options,
    now: () => new Date(now),
    idGenerator: () => {
      id += 1;
      return String(id).padStart(4, "0");
    },
  });
}

function makeReadRequest(requestId = "read-account") {
  return {
    requestId,
    accountId,
    requestedAt: now,
  };
}

function makeIntent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return tradeIntentSchema.parse({
    intentId: "intent-live-buy",
    accountId,
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    side: "BUY",
    quantity: 100,
    limitPrice: 10,
    currency: "CNY",
    source: "test",
    createdAt: now,
    ...overrides,
  });
}

function makeAllowedGate(requestedAction: "submit_order" | "cancel_order" = "submit_order"): LiveTradingGateResult {
  return evaluateLiveTradingGate({
    requestedAt: now,
    liveTradingEnvEnabled: true,
    tradingMode: "live",
    brokerProvider: "fake_live",
    accountId,
    symbol: "000636",
    market: "SZSE",
    requestedAction,
    allowlist: {
      allowlistId: "live-account-allowlist",
      updatedAt: now,
      entries: [
        {
          accountId,
          brokerProvider: "fake_live",
          tradingMode: "live",
          status: "enabled",
          reason: "fake live account for broker adapter contract",
          createdAt: now,
          updatedAt: now,
          metadata: {},
        },
      ],
      metadata: {},
    },
    manualConfirmation: makeManualConfirmation(),
    policyResult: policyPassed,
    riskResult: riskPassed,
    killSwitchState: makeKillSwitchState(),
    auditWritable: true,
  });
}

function makeRejectedGate(): LiveTradingGateResult {
  return evaluateLiveTradingGate({
    requestedAt: now,
    liveTradingEnvEnabled: true,
    tradingMode: "live",
    brokerProvider: "fake_live",
    accountId,
    policyResult: policyPassed,
    riskResult: riskPassed,
    auditWritable: true,
  });
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
