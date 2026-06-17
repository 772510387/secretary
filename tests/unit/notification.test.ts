import { describe, expect, it } from "vitest";
import {
  evaluateNotificationPolicy,
  formatNotificationForConsole,
  notificationEventSchema,
  planNotificationRoute,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";

const occurredAt = "2026-06-14T02:00:00.000Z";

describe("NotificationEvent", () => {
  it("validates notification event shape and required audit linkage", () => {
    const event = makeEvent();

    expect(notificationEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      eventId: "notification-001",
      occurredAt,
      severity: "warning",
      source: {
        type: "cerebellum",
        id: "market-sentinel",
      },
      target: {
        type: "symbol",
        symbol: "000636",
        market: "SZSE",
      },
      auditEventId: "audit-001",
    });
  });

  it("rejects symbol targets without a symbol", () => {
    expect(
      notificationEventSchema.safeParse({
        ...makeEvent(),
        target: {
          type: "symbol",
          market: "SZSE",
        },
      }).success,
    ).toBe(false);
  });
});

describe("notification formatting", () => {
  it("formats console output and redacts secrets", () => {
    const output = formatNotificationForConsole(
      makeEvent({
        summary: "Stop loss triggered token=abc123",
        recommendedAction: "Review position with apiKey=sk-test-secret-123456",
        metadata: {
          password: "plain-text",
        },
      }),
    );

    expect(output).toContain("WARNING");
    expect(output).toContain("source=cerebellum:market-sentinel");
    expect(output).toContain("target=SZSE:000636:Fenghua Hi-Tech");
    expect(output).toContain("audit=audit-001");
    expect(output).toContain("token=[redacted]");
    expect(output).toContain("apiKey=[redacted]");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("sk-test-secret");
  });
});

describe("notification policy", () => {
  it("sends first notification, skips duplicates, and applies cooldown", () => {
    const first = evaluateNotificationPolicy(makeEvent(), {}, { now: occurredAt });
    const duplicate = evaluateNotificationPolicy(
      makeEvent({
        eventId: "notification-duplicate",
      }),
      first.nextState,
      {
        now: "2026-06-14T02:01:00.000Z",
      },
    );
    const cooldown = evaluateNotificationPolicy(
      makeEvent({
        eventId: "notification-cooldown",
        summary: "A different warning for same target.",
      }),
      first.nextState,
      {
        now: "2026-06-14T02:02:00.000Z",
      },
    );

    expect(first.status).toBe("send");
    expect(duplicate.status).toBe("skip_duplicate");
    expect(cooldown.status).toBe("skip_cooldown");
  });

  it("does not suppress critical notifications with normal cooldown", () => {
    const first = evaluateNotificationPolicy(makeEvent(), {}, { now: occurredAt });
    const critical = evaluateNotificationPolicy(
      makeEvent({
        eventId: "notification-critical",
        severity: "critical",
        summary: "Critical event for same target.",
      }),
      first.nextState,
      {
        now: "2026-06-14T02:02:00.000Z",
      },
    );

    expect(critical.status).toBe("send");
  });
});

describe("notification routing", () => {
  it("routes severities from config and keeps external channels disabled by default", () => {
    const info = planNotificationRoute(makeEvent({
      severity: "info",
    }), {}, {
      routeConfig: {
        info: ["file"],
      },
    });
    const warning = planNotificationRoute(makeEvent({
      severity: "warning",
    }), {}, {
      routeConfig: {
        warning: ["console", "file"],
      },
    });
    const critical = planNotificationRoute(makeEvent({
      severity: "critical",
      eventId: "notification-critical-route",
      summary: "Critical warning token=abc123",
    }), {}, {
      routeConfig: {
        critical: ["console", "file", "webhook"],
      },
    });

    expect(info.channels).toEqual(["file"]);
    expect(warning.channels).toEqual(["console", "file"]);
    expect(critical.channels).toEqual(["console", "file"]);
    expect(critical.skippedChannels).toContainEqual({
      channel: "webhook",
      reason: "external_disabled",
    });
    expect(critical.auditEvent).toMatchObject({
      eventId: "audit-notification-critical-notification-critical-route",
      action: "notify",
      severity: "critical",
      metadata: {
        notificationEventId: "notification-critical-route",
        channels: ["console", "file"],
        criticalAuditRequired: true,
        brokerSubmissionAllowed: false,
        accountWriteAllowed: false,
        liveTradingAllowed: false,
      },
    });
    expect(JSON.stringify(critical.auditEvent)).not.toContain("abc123");
  });

  it("can explicitly enable webhook routing while keeping wechat closed", () => {
    const plan = planNotificationRoute(makeEvent({
      severity: "critical",
      eventId: "notification-critical-webhook",
    }), {}, {
      routeConfig: {
        critical: ["console", "file", "webhook", "wechat"],
        externalChannelsEnabled: ["webhook"],
      },
    });

    expect(plan.channels).toEqual(["console", "file", "webhook"]);
    expect(plan.skippedChannels).toContainEqual({
      channel: "wechat",
      reason: "external_disabled",
    });
    expect(plan.auditEvent?.metadata).toMatchObject({
      externalChannels: ["webhook"],
    });
  });

  it("suppresses same-class warnings through cooldown but lets critical pass", () => {
    const first = planNotificationRoute(makeEvent(), {}, { now: occurredAt });
    const warning = planNotificationRoute(makeEvent({
      eventId: "notification-warning-cooldown",
      summary: "Different warning for same target.",
    }), first.nextState, {
      now: "2026-06-14T02:02:00.000Z",
    });
    const critical = planNotificationRoute(makeEvent({
      eventId: "notification-critical-cooldown",
      severity: "critical",
      summary: "Critical event for same target.",
    }), first.nextState, {
      now: "2026-06-14T02:02:00.000Z",
    });

    expect(first.status).toBe("send");
    expect(warning.status).toBe("skip_cooldown");
    expect(warning.channels).toEqual([]);
    expect(critical.status).toBe("send");
    expect(critical.channels).toEqual(["console", "file"]);
    expect(critical.auditEvent).toBeDefined();
  });
});

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "notification-001",
    occurredAt,
    severity: "warning",
    source: {
      type: "cerebellum",
      id: "market-sentinel",
      name: "Market Sentinel",
    },
    target: {
      type: "symbol",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
    },
    summary: "Stop loss warning for paper position.",
    recommendedAction: "Review position and create manual proposal if needed.",
    auditEventId: "audit-001",
    correlationId: "event-001",
    channels: ["console", "file"],
    metadata: {
      liveTrading: false,
      brokerConnected: false,
    },
    ...overrides,
  });
}
