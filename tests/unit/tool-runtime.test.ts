import { describe, expect, it } from "vitest";
import {
  brainInputSchema,
  planToolRuntimeRequest,
  toolRuntimePlanSchema,
} from "../../src/domain/brain/index.js";
import {
  memoryWriteRequestSchema,
  type MemoryWriteRequest,
} from "../../src/domain/memory/index.js";

const now = "2026-06-14T02:00:00.000Z";

describe("ToolRuntime request planner", () => {
  it("turns legal read-only requests into non-executable plans", () => {
    const plan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-read-memory-001",
        toolType: "read_memory",
        payload: {
          category: "rules",
          relativePath: "memory/rules/risk.md",
        },
      }),
      { now },
    );

    expect(toolRuntimePlanSchema.safeParse(plan).success).toBe(true);
    expect(plan).toMatchObject({
      requestId: "tool-read-memory-001",
      toolType: "read_memory",
      status: "planned",
      action: "read_memory",
      canExecute: false,
      executionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      auditEvent: {
        action: "validate",
        result: "success",
        metadata: {
          toolType: "read_memory",
          planAction: "read_memory",
          canExecute: false,
        },
      },
    });
  });

  it("plans search, quote, and history requests without granting execution", () => {
    const plans = [
      planToolRuntimeRequest(
        makeToolRequest({
          requestId: "tool-search-001",
          toolType: "search_memory",
          payload: {
            query: "risk",
            categories: ["rules"],
            limit: 5,
          },
        }),
        { now },
      ),
      planToolRuntimeRequest(
        makeToolRequest({
          requestId: "tool-quote-001",
          toolType: "get_quote",
          payload: {
            symbol: "000001",
            market: "SZSE",
          },
        }),
        { now },
      ),
      planToolRuntimeRequest(
        makeToolRequest({
          requestId: "tool-history-001",
          toolType: "fetch_history",
          payload: {
            symbol: "600000",
            market: "SSE",
            count: 20,
            endDate: "2026-06-12",
          },
        }),
        { now },
      ),
    ];

    expect(plans.map((plan) => plan.status)).toEqual(["planned", "planned", "planned"]);
    expect(plans.map((plan) => plan.canExecute)).toEqual([false, false, false]);
    expect(plans.map((plan) => plan.executionAllowed)).toEqual([false, false, false]);
  });

  it("routes memory write requests through MemoryWritePolicy", () => {
    const allowedPlan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-memory-allow-001",
        toolType: "propose_memory_write",
        payload: makeMemoryWriteRequest({
          requestId: "memory-write-allow-001",
          writeType: "experience_summary",
          operation: "append",
          targetCategory: "long_term",
          targetPath: "memory/long_term/2026-06/week3.md",
        }),
      }),
      { now },
    );
    const proposalPlan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-memory-proposal-001",
        toolType: "propose_memory_write",
        payload: makeMemoryWriteRequest({
          requestId: "memory-write-proposal-001",
          writeType: "stop_loss_rule_change",
          operation: "update",
          targetCategory: "rules",
          targetPath: "memory/rules/risk.md",
          riskControls: {
            weakensHardRule: true,
          },
        }),
      }),
      { now },
    );

    expect(allowedPlan).toMatchObject({
      status: "planned",
      action: "memory_write_allowed",
      payload: {
        decision: {
          status: "allow",
          autoApplyAllowed: true,
        },
      },
      canExecute: false,
    });
    expect(proposalPlan).toMatchObject({
      status: "proposal_required",
      action: "memory_write_review_proposal",
      proposal: {
        proposalType: "memory_write_review",
        status: "pending_review",
        source: {
          requestId: "memory-write-proposal-001",
        },
        executionGuard: {
          executable: false,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
        },
      },
    });
  });

  it("turns trade intent requests into manual review proposals only", () => {
    const plan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-trade-001",
        toolType: "propose_trade_intent",
        payload: {
          intentId: "buy-watch-000001",
          symbol: "000001",
          market: "SZSE",
          side: "BUY",
          quantity: 100,
          limitPrice: 10.5,
          rationale: "Mock brain idea for human review only.",
        },
      }),
      { now },
    );

    expect(plan).toMatchObject({
      status: "proposal_required",
      action: "trade_intent_review_proposal",
      canExecute: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      proposal: {
        proposalType: "trade_intent_review",
        status: "pending_review",
        source: {
          sourceType: "brain_tool_request",
          requestId: "tool-trade-001",
          toolType: "propose_trade_intent",
        },
        symbol: "000001",
        side: "BUY",
        executionGuard: {
          requiresManualReview: true,
          executable: false,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
        },
      },
    });
  });

  it("rejects forbidden tool requests with metadata-only audit", () => {
    const plan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-forbidden-001",
        toolType: "execute_order",
        payload: {
          symbol: "000001",
          secret: "sk-live-secret",
          order: {
            side: "BUY",
            quantity: 100,
          },
        },
      }),
      { now },
    );

    expect(plan).toMatchObject({
      status: "rejected",
      action: "reject",
      payload: {},
      rejectionReasons: ["forbidden_tool"],
      auditEvent: {
        result: "rejected",
        severity: "warning",
        metadata: {
          toolType: "execute_order",
          rejectionCategory: "forbidden_tool",
          canExecute: false,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
        },
      },
    });
    expect(JSON.stringify(plan.auditEvent)).not.toContain("sk-live-secret");
    expect(JSON.stringify(plan.auditEvent)).not.toContain("quantity");
  });

  it("rejects memory direct orders through MemoryWritePolicy", () => {
    const plan = planToolRuntimeRequest(
      makeToolRequest({
        requestId: "tool-memory-reject-001",
        toolType: "propose_memory_write",
        payload: makeMemoryWriteRequest({
          requestId: "memory-write-reject-001",
          writeType: "direct_order",
          operation: "create",
          targetCategory: "orders",
          targetPath: "memory/orders/direct-order.json",
          riskControls: {
            touchesAccountOrOrder: true,
            convertsModelOutputToOrder: true,
          },
        }),
      }),
      { now },
    );

    expect(plan.status).toBe("rejected");
    expect(plan.rejectionReasons).toContain("direct_order");
    expect(plan.rejectionReasons).toContain("account_or_order_write");
    expect(plan.proposal).toBeUndefined();
    expect(plan.canExecute).toBe(false);
  });

  it("keeps brain input tool permissions non-executable", () => {
    expect(
      brainInputSchema.safeParse({
        requestId: "brain-tool-permission-001",
        taskType: "trade_idea",
        prompt: "propose only",
        context: {},
        constraints: {
          toolPermissions: [
            {
              toolName: "execute_order",
              visibility: "propose_only",
              canExecute: true,
            },
          ],
        },
      }).success,
    ).toBe(false);
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
    reason: "Structured mock request.",
    ...overrides,
  };
}

function makeMemoryWriteRequest(
  overrides: Omit<Partial<MemoryWriteRequest>, "riskControls"> & {
    riskControls?: Partial<MemoryWriteRequest["riskControls"]>;
  } = {},
): MemoryWriteRequest {
  return memoryWriteRequestSchema.parse({
    requestId: "memory-write-001",
    requestedAt: now,
    requestedBy: {
      sourceType: "brain",
      sourceId: "mock-brain",
    },
    writeType: "experience_summary",
    operation: "append",
    targetCategory: "long_term",
    targetPath: "memory/long_term/2026-06/week3.md",
    title: "Experience summary",
    contentSummary: "Only a summary is included in the tool request.",
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
