import { describe, expect, it } from "vitest";
import { planToolRuntimeRequests } from "../../src/app/index.js";
import {
  memoryWriteRequestSchema,
  type MemoryWriteRequest,
} from "../../src/domain/memory/index.js";

const now = "2026-06-14T02:30:00.000Z";

describe("ToolRuntime app planner", () => {
  it("plans a mixed mock tool batch without executing broker, account, or network tools", () => {
    const result = planToolRuntimeRequests({
      now,
      requests: [
        makeToolRequest({
          requestId: "app-tool-search-001",
          toolType: "search_memory",
          payload: {
            query: "stop loss",
            categories: ["rules"],
            limit: 3,
          },
        }),
        makeToolRequest({
          requestId: "app-tool-memory-001",
          toolType: "propose_memory_write",
          payload: makeMemoryWriteRequest({
            requestId: "app-memory-write-001",
            writeType: "t1_rule_change",
            operation: "update",
            targetCategory: "rules",
            targetPath: "memory/rules/trading.md",
          }),
        }),
        makeToolRequest({
          requestId: "app-tool-trade-001",
          toolType: "propose_trade_intent",
          payload: {
            symbol: "600000",
            market: "SSE",
            side: "WATCH",
            rationale: "Mock watch intent for manual review.",
          },
        }),
        makeToolRequest({
          requestId: "app-tool-secret-001",
          toolType: "read_secret",
          payload: {
            name: "OPENAI_API_KEY",
            value: "sk-test-secret",
          },
        }),
      ],
    });

    expect(result).toMatchObject({
      plannedCount: 1,
      proposalRequiredCount: 2,
      rejectedCount: 1,
    });
    expect(result.plans.map((plan) => plan.canExecute)).toEqual([false, false, false, false]);
    expect(result.plans.map((plan) => plan.brokerSubmissionAllowed)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(result.plans.map((plan) => plan.accountWriteAllowed)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(result.plans[1]).toMatchObject({
      action: "memory_write_review_proposal",
      proposal: {
        proposalType: "memory_write_review",
        status: "pending_review",
      },
    });
    expect(result.plans[2]).toMatchObject({
      action: "trade_intent_review_proposal",
      proposal: {
        proposalType: "trade_intent_review",
        source: {
          sourceType: "brain_tool_request",
        },
        executionGuard: {
          executable: false,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
        },
      },
    });
    expect(result.plans[3]).toMatchObject({
      status: "rejected",
      rejectionReasons: ["forbidden_tool"],
      auditEvent: {
        result: "rejected",
      },
    });
    expect(JSON.stringify(result.plans[3].auditEvent)).not.toContain("sk-test-secret");
  });
});

function makeToolRequest(overrides: {
  requestId: string;
  toolType: string;
  payload: unknown;
}): Record<string, unknown> {
  return {
    requestedAt: now,
    requestedBy: {
      type: "brain",
      id: "mock-brain",
    },
    reason: "Batch mock request.",
    ...overrides,
  };
}

function makeMemoryWriteRequest(
  overrides: Omit<Partial<MemoryWriteRequest>, "riskControls"> & {
    riskControls?: Partial<MemoryWriteRequest["riskControls"]>;
  } = {},
): MemoryWriteRequest {
  return memoryWriteRequestSchema.parse({
    requestId: "app-memory-write-001",
    requestedAt: now,
    requestedBy: {
      sourceType: "brain",
      sourceId: "mock-brain",
    },
    writeType: "t1_rule_change",
    operation: "update",
    targetCategory: "rules",
    targetPath: "memory/rules/trading.md",
    title: "T1 rule review",
    contentSummary: "Only a proposal summary is sent through the planner.",
    evidenceRefs: ["memory/reports/2026-06-14/daily-reflection.json"],
    metadata: {},
    ...overrides,
    riskControls: {
      weakensHardRule: false,
      touchesLiveTrading: false,
      touchesBrokerBoundary: false,
      touchesAccountOrOrder: false,
      containsSecret: false,
      deletesAudit: false,
      bypassesRisk: false,
      convertsModelOutputToOrder: false,
      ...overrides.riskControls,
    },
  });
}
