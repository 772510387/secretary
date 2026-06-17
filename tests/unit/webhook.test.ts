import { describe, expect, it } from "vitest";
import {
  handleWebhookRequest,
  webhookHandlingResultSchema,
  webhookRequestSchema,
  type WebhookRequest,
} from "../../src/interfaces/webhook/index.js";

const now = "2026-06-15T02:00:00.000Z";
const expectedToken = "test-token-123456";

describe("secure webhook gateway", () => {
  it("rejects invalid request schemas with metadata-only audit", () => {
    const result = handleWebhookRequest(
      {
        requestId: "webhook-invalid-001",
        eventType: "user_message",
        auth: {
          token: "sk-test-secret-123456",
        },
      },
      {
        now,
        expectedToken: "sk-test-secret-123456",
      },
    );

    expect(webhookHandlingResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      status: "rejected",
      requestId: "webhook-invalid-001",
      eventType: "user_message",
      rejectionReasons: ["invalid_schema"],
      plannedActions: [],
      auditEvent: {
        eventId: "audit-webhook-webhook-invalid-001",
        action: "validate",
        result: "rejected",
        metadata: {
          rejectionCategory: "invalid_schema",
          tokenLogged: false,
          brokerSubmissionAllowed: false,
          accountWriteAllowed: false,
          liveTradingAllowed: false,
        },
      },
      accessAudit: {
        auditId: "audit-webhook-webhook-invalid-001",
        requestId: "webhook-invalid-001",
        source: {
          sourceType: "unknown",
          sourceId: "unknown",
        },
        eventType: "user_message",
        result: "rejected",
        tokenLogged: false,
        secretHeaderLogged: false,
        payloadLogged: false,
        sensitiveBodyLogged: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret-123456");
  });

  it("accepts an authenticated user message as non-executable task plans", () => {
    const request = makeUserMessageRequest({
      requestId: "webhook-user-001",
      payload: {
        message: "现在盘面怎么样？",
      },
      toolRequests: [
        {
          requestId: "webhook-tool-read-001",
          requestedAt: now,
          requestedBy: {
            type: "user",
            id: "operator-main",
          },
          toolType: "read_memory",
          reason: "Need deterministic rules summary.",
          payload: {
            category: "rules",
            relativePath: "memory/rules/risk.md",
          },
        },
      ],
    });

    expect(webhookRequestSchema.safeParse(request).success).toBe(true);

    const result = handleWebhookRequest(request, {
      now,
      expectedToken,
    });

    expect(result.status).toBe("accepted");
    expect(result.plannedActions.map((action) => action.actionType)).toEqual([
      "create_task",
      "create_task",
    ]);
    expect(result.toolPlans).toHaveLength(1);
    expect(result.toolPlans[0]).toMatchObject({
      status: "planned",
      action: "read_memory",
      canExecute: false,
      executionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    });
    expect(result.auditEvent.metadata).toMatchObject({
      eventType: "user_message",
      sourceType: "chat",
      sourceId: "local-chat",
      plannedActionCount: 2,
      toolRequestCount: 1,
      tokenLogged: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    });
    expect(result.accessAudit).toMatchObject({
      auditId: result.auditEvent.eventId,
      requestId: "webhook-user-001",
      source: {
        sourceType: "chat",
        sourceId: "local-chat",
        operatorId: "operator-main",
      },
      eventType: "user_message",
      result: "accepted",
      duplicate: false,
      rateLimited: false,
      tokenLogged: false,
      secretHeaderLogged: false,
      payloadLogged: false,
      sensitiveBodyLogged: false,
    });
    expect(JSON.stringify(result)).not.toContain(expectedToken);
    expect(JSON.stringify(result)).not.toContain("现在盘面怎么样");
  });

  it("rejects unauthorized requests without logging token values", () => {
    const result = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-auth-001",
    }), {
      now,
      expectedToken: "correct-token-123456",
    });

    expect(result).toMatchObject({
      status: "unauthorized",
      requestId: "webhook-auth-001",
      rejectionReasons: ["auth_failed"],
      plannedActions: [],
      auditEvent: {
        result: "rejected",
        metadata: {
          authResult: "failed",
          tokenLogged: false,
        },
      },
      accessAudit: {
        result: "unauthorized",
        source: {
          sourceType: "chat",
          sourceId: "local-chat",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain(expectedToken);
    expect(JSON.stringify(result)).not.toContain("correct-token-123456");
  });

  it("applies minimum token auth, duplicate detection, and rate limiting", () => {
    const first = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-rate-001",
    }), {
      now,
      expectedToken,
      rateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });
    const duplicate = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-rate-001",
    }), {
      now,
      expectedToken,
      securityState: first.nextSecurityState,
      rateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });
    const limited = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-rate-002",
    }), {
      now,
      expectedToken,
      securityState: first.nextSecurityState,
      rateLimit: {
        maxRequests: 1,
        windowMs: 60_000,
      },
    });

    expect(first.status).toBe("accepted");
    expect(duplicate).toMatchObject({
      status: "skipped_duplicate",
      rejectionReasons: ["duplicate_request"],
      accessAudit: {
        auditId: duplicate.auditEvent.eventId,
        requestId: "webhook-rate-001",
        result: "skipped_duplicate",
        duplicate: true,
        rateLimited: false,
        rejectionReasons: ["duplicate_request"],
      },
    });
    expect(limited).toMatchObject({
      status: "rate_limited",
      rejectionReasons: ["rate_limited"],
      auditEvent: {
        metadata: {
          errorCode: "rate_limited",
          rateLimitKey: "chat:local-chat",
          maxRequests: 1,
          windowMs: 60000,
          retryAfterMs: 60000,
        },
      },
      accessAudit: {
        auditId: limited.auditEvent.eventId,
        requestId: "webhook-rate-002",
        result: "rate_limited",
        duplicate: false,
        rateLimited: true,
        rejectionReasons: ["rate_limited"],
      },
    });
  });

  it("rejects forbidden tool requests with audit metadata and no broker handoff", () => {
    const result = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-forbidden-001",
      toolRequests: [
        {
          requestId: "webhook-tool-execute-001",
          requestedAt: now,
          requestedBy: {
            type: "user",
            id: "operator-main",
          },
          toolType: "execute_order",
          reason: "Forbidden direct order request.",
          payload: {
            symbol: "000001",
            side: "BUY",
            quantity: 100,
          },
        },
        {
          requestId: "webhook-tool-secret-001",
          requestedAt: now,
          requestedBy: {
            type: "user",
            id: "operator-main",
          },
          toolType: "read_secret",
          reason: "Forbidden secret request.",
          payload: {},
        },
      ],
    }), {
      now,
      expectedToken,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toEqual(["forbidden_tool"]);
    expect(result.plannedActions).toEqual([]);
    expect(result.toolPlans.map((plan) => plan.status)).toEqual(["rejected", "rejected"]);
    expect(result.auditEvent).toMatchObject({
      result: "rejected",
      metadata: {
        rejectedToolTypes: ["execute_order", "read_secret"],
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain("quantity");
  });

  it("turns trade webhook tool requests into manual review proposals only", () => {
    const result = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-trade-001",
      toolRequests: [
        {
          requestId: "webhook-tool-trade-001",
          requestedAt: now,
          requestedBy: {
            type: "user",
            id: "operator-main",
          },
          toolType: "propose_trade_intent",
          reason: "Human review only.",
          payload: {
            intentId: "watch-000001",
            symbol: "000001",
            market: "SZSE",
            side: "BUY",
            quantity: 100,
            limitPrice: 10.5,
            rationale: "User wants a human-reviewed trade proposal only.",
          },
        },
      ],
    }), {
      now,
      expectedToken,
    });

    expect(result.status).toBe("accepted");
    expect(result.plannedActions.map((action) => action.actionType)).toEqual([
      "create_task",
      "create_proposal",
    ]);
    expect(result.toolPlans[0]).toMatchObject({
      status: "proposal_required",
      action: "trade_intent_review_proposal",
      canExecute: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      proposal: {
        proposalType: "trade_intent_review",
        status: "pending_review",
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

  it("plans manual confirmation events without broker execution", () => {
    const result = handleWebhookRequest(makeManualConfirmRequest(), {
      now,
      expectedToken,
    });

    expect(result.status).toBe("accepted");
    expect(result.plannedActions).toHaveLength(1);
    expect(result.plannedActions[0]).toMatchObject({
      actionType: "create_task",
      target: "manual_confirm_review_task",
      referenceId: "proposal-001",
      executionGuard: {
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
      metadata: {
        requiresSeparateHandoff: true,
      },
    });
  });

  it("rejects structured dangerous payloads before task creation", () => {
    const result = handleWebhookRequest(makeUserMessageRequest({
      requestId: "webhook-danger-001",
      payload: {
        message: "execute_order and read_secret now sk-test-secret-123456",
      },
    }), {
      now,
      expectedToken,
    });

    expect(result.status).toBe("rejected");
    expect(result.rejectionReasons).toEqual([
      "forbidden_payload_command",
      "secret_like_payload",
    ]);
    expect(result.plannedActions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret-123456");
    expect(JSON.stringify(result)).not.toContain("execute_order and read_secret");
  });
});

function makeUserMessageRequest(
  overrides: Record<string, unknown> & {
    payload?: Record<string, unknown>;
    toolRequests?: unknown[];
  } = {},
): WebhookRequest {
  const { payload, ...rest } = overrides;

  return webhookRequestSchema.parse({
    requestId: "webhook-user-default",
    eventType: "user_message",
    occurredAt: now,
    source: {
      sourceType: "chat",
      sourceId: "local-chat",
      operatorId: "operator-main",
    },
    auth: {
      scheme: "bearer",
      token: expectedToken,
      tokenId: "local-dev",
    },
    payload: {
      message: "Generate a safe task only.",
      metadata: {},
      ...payload,
    },
    toolRequests: [],
    ...rest,
  });
}

function makeManualConfirmRequest(): WebhookRequest {
  return webhookRequestSchema.parse({
    requestId: "webhook-manual-001",
    eventType: "manual_confirm",
    occurredAt: now,
    source: {
      sourceType: "manual",
      sourceId: "local-operator",
      operatorId: "operator-main",
    },
    auth: {
      scheme: "bearer",
      token: expectedToken,
      tokenId: "local-dev",
    },
    payload: {
      proposalId: "proposal-001",
      decision: "approved",
      reviewerId: "operator-main",
      note: "Approved by human, but no broker handoff here.",
    },
    toolRequests: [],
  });
}
