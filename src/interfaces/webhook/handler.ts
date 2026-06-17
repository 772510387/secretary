import { z } from "zod";
import {
  planToolRuntimeRequest,
  type ToolRuntimePlan,
  type ToolRuntimeRequest,
} from "../../domain/brain/index.js";
import { auditEventSchema, type AuditEvent } from "../../domain/audit/index.js";
import type { JsonValue } from "../../domain/shared/index.js";
import {
  webhookAccessAuditSchema,
  webhookAccessAuditSourceSchema,
  webhookHandlingResultSchema,
  webhookPlannedActionSchema,
  webhookRequestSchema,
  webhookSecurityStateSchema,
  type WebhookAccessAudit,
  type WebhookAccessAuditSource,
  type WebhookEventType,
  type WebhookHandlingResult,
  type WebhookHandlingStatus,
  type WebhookPlannedAction,
  type WebhookRequest,
  type WebhookSecurityState,
} from "./schemas.js";

export const DEFAULT_WEBHOOK_RATE_LIMIT = {
  maxRequests: 60,
  windowMs: 60_000,
} as const;

export interface WebhookRateLimitOptions {
  maxRequests: number;
  windowMs: number;
}

export interface HandleWebhookRequestOptions {
  now?: Date | string;
  expectedToken?: string;
  securityState?: WebhookSecurityState;
  rateLimit?: WebhookRateLimitOptions;
}

interface RejectionInput {
  status: Exclude<WebhookHandlingResult["status"], "accepted">;
  request?: WebhookRequest;
  requestId: string;
  eventType?: WebhookEventType;
  source?: WebhookAccessAuditSource;
  occurredAt: string;
  reasons: readonly string[];
  metadata: Record<string, JsonValue>;
  nextSecurityState: WebhookSecurityState;
  toolPlans?: readonly ToolRuntimePlan[];
}

const forbiddenPayloadKeys = [
  "api_key",
  "apikey",
  "broker_command",
  "credential",
  "enable_live_trading",
  "execute_order",
  "order_request",
  "overwrite_rule",
  "password",
  "private_key",
  "read_secret",
  "secret",
  "submit_order",
  "token",
  "write_account",
] as const;

const forbiddenCommandPattern =
  /\b(execute_order|submit_order|write_account|overwrite_rule|enable_live_trading|read_secret)\b/i;
const secretLikePattern = /\bsk-[A-Za-z0-9_-]{8,}\b/;
const knownWebhookSourceTypes = ["chat", "alert", "scheduler", "manual", "system", "test"] as const;

export function handleWebhookRequest(
  input: unknown,
  options: HandleWebhookRequestOptions = {},
): WebhookHandlingResult {
  const occurredAt = normalizeDate(options.now ?? new Date()).toISOString();
  const parseResult = webhookRequestSchema.safeParse(input);
  const initialState = normalizeSecurityState(options.securityState);

  if (!parseResult.success) {
    return rejectedResult({
      status: "rejected",
      requestId: requestIdFromUnknown(input, "webhook-invalid"),
      eventType: eventTypeFromUnknown(input),
      source: sourceFromUnknown(input),
      occurredAt,
      reasons: ["invalid_schema"],
      metadata: zodErrorMetadata(parseResult.error),
      nextSecurityState: initialState,
    });
  }

  const request = parseResult.data;
  const requestTime = normalizeDate(options.now ?? request.occurredAt ?? new Date()).toISOString();

  if (!options.expectedToken || options.expectedToken.trim().length === 0) {
    return rejectedResult({
      status: "unauthorized",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: ["auth_not_configured"],
      metadata: authMetadata(request, "not_configured"),
      nextSecurityState: initialState,
    });
  }

  if (!timingSafeEqualString(request.auth.token, options.expectedToken)) {
    return rejectedResult({
      status: "unauthorized",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: ["auth_failed"],
      metadata: authMetadata(request, "failed"),
      nextSecurityState: initialState,
    });
  }

  if (initialState.recentRequestIds[request.requestId] !== undefined) {
    return rejectedResult({
      status: "skipped_duplicate",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: ["duplicate_request"],
      metadata: {
        ...authMetadata(request, "passed"),
        firstSeenAt: initialState.recentRequestIds[request.requestId],
      },
      nextSecurityState: initialState,
    });
  }

  const rateLimit = normalizeRateLimit(options.rateLimit);
  const rateLimitResult = applyRateLimit(initialState, request, requestTime, rateLimit);

  if (!rateLimitResult.allowed) {
    return rejectedResult({
      status: "rate_limited",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: ["rate_limited"],
      metadata: {
        ...authMetadata(request, "passed"),
        rateLimitKey: rateLimitResult.bucketKey,
        maxRequests: rateLimit.maxRequests,
        windowMs: rateLimit.windowMs,
        retryAfterMs: rateLimitResult.retryAfterMs,
        errorCode: "rate_limited",
      },
      nextSecurityState: rateLimitResult.nextSecurityState,
    });
  }

  const acceptedState = {
    ...rateLimitResult.nextSecurityState,
    recentRequestIds: {
      ...rateLimitResult.nextSecurityState.recentRequestIds,
      [request.requestId]: requestTime,
    },
  };
  const dangerousReasons = detectDangerousPayload(request);

  if (dangerousReasons.length > 0) {
    return rejectedResult({
      status: "rejected",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: dangerousReasons,
      metadata: {
        ...authMetadata(request, "passed"),
        dangerousPayloadReasonCount: dangerousReasons.length,
      },
      nextSecurityState: acceptedState,
    });
  }

  const toolPlanResult = planWebhookToolRequests(request, requestTime);

  if (toolPlanResult.rejectionReasons.length > 0) {
    return rejectedResult({
      status: "rejected",
      request,
      requestId: request.requestId,
      eventType: request.eventType,
      occurredAt: requestTime,
      reasons: toolPlanResult.rejectionReasons,
      metadata: {
        ...authMetadata(request, "passed"),
        toolRequestCount: request.toolRequests.length,
        rejectedToolTypes: toolPlanResult.toolPlans
          .filter((plan) => plan.status === "rejected")
          .map((plan) => plan.toolType),
      },
      nextSecurityState: acceptedState,
      toolPlans: toolPlanResult.toolPlans,
    });
  }

  const plannedActions = [
    baseActionForRequest(request),
    ...actionsFromToolPlans(request, toolPlanResult.toolPlans),
  ];
  const auditEvent = auditEventForWebhook({
    request,
    occurredAt: requestTime,
    result: "success",
    severity: "info",
    message: `Webhook accepted ${request.eventType} request ${request.requestId}`,
    metadata: {
      ...authMetadata(request, "passed"),
      plannedActionTypes: plannedActions.map((action) => action.actionType),
      plannedActionCount: plannedActions.length,
      toolRequestCount: request.toolRequests.length,
      toolPlanStatuses: toolPlanResult.toolPlans.map((plan) => plan.status),
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
  });

  return webhookHandlingResultSchema.parse({
    status: "accepted",
    requestId: request.requestId,
    eventType: request.eventType,
    occurredAt: requestTime,
    plannedActions,
    toolPlans: toolPlanResult.toolPlans,
    rejectionReasons: [],
    auditEvent,
    accessAudit: accessAuditForWebhook({
      request,
      auditEvent,
      status: "accepted",
      occurredAt: requestTime,
      rejectionReasons: [],
    }),
    nextSecurityState: acceptedState,
  });
}

function planWebhookToolRequests(
  request: WebhookRequest,
  occurredAt: string,
): {
  toolPlans: ToolRuntimePlan[];
  rejectionReasons: string[];
} {
  const toolPlans: ToolRuntimePlan[] = [];
  const rejectionReasons: string[] = [];

  for (const toolRequest of request.toolRequests) {
    try {
      const plan = planToolRuntimeRequest(normalizeToolRequest(toolRequest, request, occurredAt), {
        now: occurredAt,
        planIdPrefix: "webhook-tool-plan",
        auditEventIdPrefix: "audit-webhook-tool",
        proposalIdPrefix: "webhook-proposal",
      });

      toolPlans.push(plan);

      if (plan.status === "rejected") {
        rejectionReasons.push(...plan.rejectionReasons);
      }
    } catch (error) {
      rejectionReasons.push("invalid_tool_request");
    }
  }

  return {
    toolPlans,
    rejectionReasons: uniqueStrings(rejectionReasons),
  };
}

function normalizeToolRequest(
  toolRequest: ToolRuntimeRequest,
  request: WebhookRequest,
  occurredAt: string,
): ToolRuntimeRequest {
  return {
    ...toolRequest,
    requestedAt: toolRequest.requestedAt ?? occurredAt,
    requestedBy: toolRequest.requestedBy ?? {
      type: request.eventType === "user_message" || request.eventType === "manual_confirm" ? "user" : "system",
      id: request.source.operatorId ?? request.source.sourceId,
    },
  };
}

function baseActionForRequest(request: WebhookRequest): WebhookPlannedAction {
  switch (request.eventType) {
    case "user_message":
      return plannedAction(request, {
        suffix: "user-message-task",
        actionType: "create_task",
        target: "user_message_brain_task",
        metadata: {
          sourceType: request.source.sourceType,
          sourceId: request.source.sourceId,
          messageLength: request.payload.message.length,
          hasToolRequests: request.toolRequests.length > 0,
        },
      });
    case "market_event":
      return plannedAction(request, {
        suffix: "market-notification",
        actionType: "create_notification",
        target: "market_event_notification",
        referenceId: request.payload.eventId,
        metadata: {
          severity: request.payload.severity,
          symbol: request.payload.symbol ?? null,
          market: request.payload.market ?? null,
          summaryLength: request.payload.summary.length,
        },
      });
    case "manual_confirm":
      return plannedAction(request, {
        suffix: "manual-confirm-review",
        actionType: "create_task",
        target: "manual_confirm_review_task",
        referenceId: request.payload.proposalId,
        metadata: {
          proposalId: request.payload.proposalId,
          decision: request.payload.decision,
          brokerSubmissionAllowed: false,
          requiresSeparateHandoff: true,
        },
      });
    case "system_event":
      return plannedAction(request, {
        suffix: "system-notification",
        actionType: "create_notification",
        target: "system_event_notification",
        referenceId: request.payload.eventName,
        metadata: {
          eventName: request.payload.eventName,
          severity: request.payload.severity,
          summaryLength: request.payload.summary.length,
        },
      });
  }
}

function actionsFromToolPlans(
  request: WebhookRequest,
  toolPlans: readonly ToolRuntimePlan[],
): WebhookPlannedAction[] {
  return toolPlans
    .filter((plan) => plan.status !== "rejected")
    .map((plan, index) => {
      if (plan.status === "proposal_required" && plan.proposal !== undefined) {
        return plannedAction(request, {
          suffix: `tool-proposal-${index + 1}`,
          actionType: "create_proposal",
          target: plan.proposal.proposalType,
          referenceId: plan.proposal.proposalId,
          metadata: {
            toolRequestId: plan.requestId,
            toolType: plan.toolType,
            planAction: plan.action,
            proposalType: plan.proposal.proposalType,
          },
        });
      }

      return plannedAction(request, {
        suffix: `tool-task-${index + 1}`,
        actionType: "create_task",
        target: `tool_runtime_${plan.action}`,
        metadata: {
          toolRequestId: plan.requestId,
          toolType: plan.toolType,
          planAction: plan.action,
          canExecute: false,
        },
      });
    });
}

function plannedAction(
  request: WebhookRequest,
  input: {
    suffix: string;
    actionType: WebhookPlannedAction["actionType"];
    target: string;
    referenceId?: string;
    metadata: Record<string, JsonValue>;
  },
): WebhookPlannedAction {
  return webhookPlannedActionSchema.parse({
    actionId: buildIdentifier(["webhook-action", request.requestId, input.suffix], 128),
    actionType: input.actionType,
    target: input.target,
    referenceId: input.referenceId,
    metadata: sanitizeJsonObject({
      ...input.metadata,
      directExecutionAllowed: false,
    }),
    executionGuard: {
      toolExecutionAllowed: false,
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
    },
  });
}

function rejectedResult(input: RejectionInput): WebhookHandlingResult {
  const auditResult = input.status === "skipped_duplicate" ? "skipped" : "rejected";
  const severity = input.status === "skipped_duplicate" ? "info" : "warning";
  const auditEvent = auditEventForWebhook({
    request: input.request,
    requestId: input.requestId,
    eventType: input.eventType,
    source: input.source,
    occurredAt: input.occurredAt,
    result: auditResult,
    severity,
    message: `Webhook ${input.status} request ${input.requestId}`,
    metadata: {
      rejectionReasons: [...input.reasons],
      brokerSubmissionAllowed: false,
      accountWriteAllowed: false,
      liveTradingAllowed: false,
      ...input.metadata,
    },
  });

  return webhookHandlingResultSchema.parse({
    status: input.status,
    requestId: input.requestId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    plannedActions: [],
    toolPlans: input.toolPlans ?? [],
    rejectionReasons: [...input.reasons],
    auditEvent,
    accessAudit: accessAuditForWebhook({
      request: input.request,
      requestId: input.requestId,
      eventType: input.eventType,
      source: input.source,
      auditEvent,
      status: input.status,
      occurredAt: input.occurredAt,
      rejectionReasons: input.reasons,
    }),
    nextSecurityState: input.nextSecurityState,
  });
}

function auditEventForWebhook(input: {
  request?: WebhookRequest;
  requestId?: string;
  eventType?: WebhookEventType;
  source?: WebhookAccessAuditSource;
  occurredAt: string;
  result: "success" | "rejected" | "skipped";
  severity: "info" | "warning";
  message: string;
  metadata: Record<string, JsonValue>;
}): AuditEvent {
  const requestId = input.request?.requestId ?? input.requestId ?? "webhook-unknown";
  const eventType = input.request?.eventType ?? input.eventType;
  const source = input.request?.source ?? input.source;

  return auditEventSchema.parse({
    eventId: buildIdentifier(["audit-webhook", requestId], 128),
    occurredAt: input.occurredAt,
    actor: {
      type: "api",
      id: "webhook",
    },
    action: "validate",
    subject: {
      type: "config",
      id: "webhook-gateway",
    },
    severity: input.severity,
    result: input.result,
    message: input.message,
    correlationId: requestId,
    metadata: sanitizeJsonObject({
      requestId,
      eventType: eventType ?? null,
      sourceType: source?.sourceType ?? null,
      sourceId: source?.sourceId ?? null,
      authTokenId: input.request?.auth.tokenId ?? null,
      tokenLogged: false,
      canExecute: false,
      toolExecutionAllowed: false,
      ...input.metadata,
    }),
  });
}

function accessAuditForWebhook(input: {
  request?: WebhookRequest;
  requestId?: string;
  eventType?: WebhookEventType;
  source?: WebhookAccessAuditSource;
  auditEvent: AuditEvent;
  status: WebhookHandlingStatus;
  occurredAt: string;
  rejectionReasons: readonly string[];
}): WebhookAccessAudit {
  const requestId = input.request?.requestId ?? input.requestId ?? "webhook-unknown";
  const eventType = input.request?.eventType ?? input.eventType ?? "unknown";

  return webhookAccessAuditSchema.parse({
    auditId: input.auditEvent.eventId,
    requestId,
    source: sourceForAccessAudit(input.request?.source ?? input.source),
    eventType,
    result: input.status,
    occurredAt: input.occurredAt,
    duplicate: input.status === "skipped_duplicate",
    rateLimited: input.status === "rate_limited",
    rejectionReasons: [...input.rejectionReasons],
    tokenLogged: false,
    secretHeaderLogged: false,
    payloadLogged: false,
    sensitiveBodyLogged: false,
  });
}

function sourceForAccessAudit(
  source: WebhookAccessAuditSource | WebhookRequest["source"] | undefined,
): WebhookAccessAuditSource {
  if (source === undefined) {
    return {
      sourceType: "unknown",
      sourceId: "unknown",
    };
  }

  return webhookAccessAuditSourceSchema.parse({
    sourceType: source.sourceType,
    sourceId: source.sourceId,
    operatorId: source.operatorId,
  });
}

function authMetadata(
  request: WebhookRequest,
  authResult: "passed" | "failed" | "not_configured",
): Record<string, JsonValue> {
  return {
    authResult,
    authScheme: request.auth.scheme,
    authTokenId: request.auth.tokenId ?? null,
    tokenLogged: false,
  };
}

function applyRateLimit(
  state: WebhookSecurityState,
  request: WebhookRequest,
  occurredAt: string,
  rateLimit: WebhookRateLimitOptions,
): {
  allowed: boolean;
  bucketKey: string;
  retryAfterMs: number;
  nextSecurityState: WebhookSecurityState;
} {
  const bucketKey = `${request.source.sourceType}:${request.source.sourceId}`;
  const existing = state.rateLimitBuckets[bucketKey];
  const occurredMs = Date.parse(occurredAt);
  const existingMs = existing ? Date.parse(existing.windowStartedAt) : Number.NaN;
  const resetWindow =
    !existing ||
    Number.isNaN(existingMs) ||
    occurredMs - existingMs < 0 ||
    occurredMs - existingMs >= rateLimit.windowMs;
  const nextBucket = resetWindow
    ? {
        windowStartedAt: occurredAt,
        count: 1,
      }
    : {
        windowStartedAt: existing.windowStartedAt,
        count: existing.count + 1,
      };

  return {
    allowed: nextBucket.count <= rateLimit.maxRequests,
    bucketKey,
    retryAfterMs: resetWindow
      ? rateLimit.windowMs
      : Math.max(0, rateLimit.windowMs - (occurredMs - existingMs)),
    nextSecurityState: webhookSecurityStateSchema.parse({
      recentRequestIds: state.recentRequestIds,
      rateLimitBuckets: {
        ...state.rateLimitBuckets,
        [bucketKey]: nextBucket,
      },
    }),
  };
}

function detectDangerousPayload(request: WebhookRequest): string[] {
  const reasons = [
    ...dangerousReasonsFromValue(request.payload),
    ...dangerousReasonsFromValue(request.toolRequests.map((toolRequest) => toolRequest.payload)),
  ];

  return uniqueStrings(reasons);
}

function dangerousReasonsFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    const reasons: string[] = [];

    if (forbiddenCommandPattern.test(value)) {
      reasons.push("forbidden_payload_command");
    }

    if (secretLikePattern.test(value)) {
      reasons.push("secret_like_payload");
    }

    return reasons;
  }

  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap(dangerousReasonsFromValue));
  }

  if (typeof value === "object" && value !== null) {
    const reasons: string[] = [];

    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenPayloadKey(key)) {
        reasons.push("forbidden_payload_key");
      }

      reasons.push(...dangerousReasonsFromValue(child));
    }

    return uniqueStrings(reasons);
  }

  return [];
}

function isForbiddenPayloadKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  return forbiddenPayloadKeys.some((forbidden) => normalized.includes(forbidden));
}

function normalizeSecurityState(state: WebhookSecurityState | undefined): WebhookSecurityState {
  return webhookSecurityStateSchema.parse(state ?? {});
}

function normalizeRateLimit(rateLimit: WebhookRateLimitOptions | undefined): WebhookRateLimitOptions {
  const normalized = rateLimit ?? DEFAULT_WEBHOOK_RATE_LIMIT;

  if (
    !Number.isInteger(normalized.maxRequests) ||
    normalized.maxRequests <= 0 ||
    !Number.isFinite(normalized.windowMs) ||
    normalized.windowMs <= 0
  ) {
    throw new WebhookHandlerError("Invalid webhook rate limit options");
  }

  return normalized;
}

function normalizeDate(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new WebhookHandlerError("Invalid webhook date");
    }

    return value;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new WebhookHandlerError(`Invalid webhook date: ${value}`);
  }

  return parsed;
}

function zodErrorMetadata(error: z.ZodError): Record<string, JsonValue> {
  const firstIssue = error.issues[0];

  return {
    rejectionCategory: "invalid_schema",
    validationIssueCount: error.issues.length,
    firstIssuePath: firstIssue ? firstIssue.path.join(".") : "",
    firstIssueCode: firstIssue?.code ?? "unknown",
  };
}

function requestIdFromUnknown(input: unknown, fallbackPrefix: string): string {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const requestId = (input as Record<string, unknown>).requestId;

    if (typeof requestId === "string") {
      return safeIdentifier(requestId, 96);
    }
  }

  return `${fallbackPrefix}-${new Date().toISOString().replace(/\D/g, "")}`;
}

function eventTypeFromUnknown(input: unknown): WebhookEventType | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const eventType = (input as Record<string, unknown>).eventType;

  if (
    eventType === "user_message" ||
    eventType === "market_event" ||
    eventType === "manual_confirm" ||
    eventType === "system_event"
  ) {
    return eventType;
  }

  return undefined;
}

function sourceFromUnknown(input: unknown): WebhookAccessAuditSource | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const source = (input as Record<string, unknown>).source;

  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }

  const sourceRecord = source as Record<string, unknown>;
  const sourceType = typeof sourceRecord.sourceType === "string" &&
    knownWebhookSourceTypes.includes(sourceRecord.sourceType as (typeof knownWebhookSourceTypes)[number])
    ? sourceRecord.sourceType
    : "unknown";
  const sourceId = typeof sourceRecord.sourceId === "string"
    ? safeIdentifier(sourceRecord.sourceId, 96)
    : "unknown";
  const operatorId = typeof sourceRecord.operatorId === "string"
    ? safeIdentifier(sourceRecord.operatorId, 96)
    : undefined;

  return webhookAccessAuditSourceSchema.parse({
    sourceType,
    sourceId,
    operatorId,
  });
}

function sanitizeJsonObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  return sanitizeJsonValue(value) as Record<string, JsonValue>;
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }

  if (typeof value === "object" && value !== null) {
    const output: Record<string, JsonValue> = {};

    for (const [key, child] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[redacted]" : sanitizeJsonValue(child);
    }

    return output;
  }

  return null;
}

function sanitizeText(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|account)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .trim();
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[-\s]/g, "_").toLowerCase();
  const compact = normalized.replace(/_/g, "");

  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized === "password" ||
    normalized.endsWith("_password") ||
    normalized === "secret" ||
    normalized.endsWith("_secret") ||
    normalized === "credential" ||
    normalized.endsWith("_credential") ||
    normalized === "api_key" ||
    compact === "apikey" ||
    normalized === "private_key" ||
    compact === "privatekey" ||
    normalized === "account" ||
    normalized === "account_id" ||
    compact === "accountid"
  );
}

function timingSafeEqualString(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    const leftCode = index < left.length ? left.charCodeAt(index) : 0;
    const rightCode = index < right.length ? right.charCodeAt(index) : 0;
    mismatch |= leftCode ^ rightCode;
  }

  return mismatch === 0;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildIdentifier(parts: readonly string[], maxLength: number): string {
  return safeIdentifier(parts.join("-"), maxLength);
}

function safeIdentifier(value: string, maxLength: number): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, maxLength);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

export class WebhookHandlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookHandlerError";
  }
}
