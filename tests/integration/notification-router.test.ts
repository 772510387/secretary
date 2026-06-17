import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/domain/audit/index.js";
import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  type NotificationDeliveryResult,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";
import {
  NotificationRouter,
  type NotificationRouterNotifier,
} from "../../src/infrastructure/notification/index.js";

const occurredAt = "2026-06-15T02:00:00.000Z";
const deliveredAt = "2026-06-15T02:00:01.000Z";

describe("NotificationRouter", () => {
  it("routes warning notifications to default local channels only", async () => {
    const calls: string[] = [];
    const router = new NotificationRouter({
      now: deliveredAt,
      notifiers: {
        console: fakeNotifier("console", calls),
        file: fakeNotifier("file", calls),
        webhook: fakeNotifier("webhook", calls),
      },
    });

    const result = await router.notify(makeEvent({
      severity: "warning",
    }));

    expect(result).toMatchObject({
      status: "sent",
      auditStatus: "not_required",
      errors: [],
    });
    expect(result.plan.channels).toEqual(["console", "file"]);
    expect(calls).toEqual(["console:notification-router-001", "file:notification-router-001"]);
    expect(result.deliveries.map((delivery) => delivery.channel)).toEqual(["console", "file"]);
  });

  it("requires critical audit before multi-channel delivery", async () => {
    const calls: string[] = [];
    const router = new NotificationRouter({
      now: deliveredAt,
      notifiers: {
        console: fakeNotifier("console", calls),
        file: fakeNotifier("file", calls),
      },
    });

    const result = await router.notify(makeEvent({
      eventId: "notification-critical-no-audit",
      severity: "critical",
    }));

    expect(result).toMatchObject({
      status: "failed",
      auditStatus: "failed",
      deliveries: [],
      errors: ["critical_notification_audit_sink_not_configured"],
    });
    expect(calls).toEqual([]);
  });

  it("writes critical audit and sends configured local plus enabled external channels", async () => {
    const calls: string[] = [];
    const auditEvents: AuditEvent[] = [];
    const router = new NotificationRouter({
      now: deliveredAt,
      auditSink: (event) => {
        auditEvents.push(event);
      },
      notifiers: {
        console: fakeNotifier("console", calls),
        file: fakeNotifier("file", calls),
        webhook: fakeNotifier("webhook", calls),
      },
      routeConfig: {
        critical: ["console", "file", "webhook", "wechat"],
        externalChannelsEnabled: ["webhook"],
      },
    });

    const result = await router.notify(makeEvent({
      eventId: "notification-critical-routed",
      severity: "critical",
      summary: "Critical with apiKey=sk-test-secret-123456",
    }));

    expect(result.status).toBe("sent");
    expect(result.auditStatus).toBe("written");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      eventId: "audit-notification-critical-notification-critical-routed",
      action: "notify",
      severity: "critical",
      metadata: {
        notificationEventId: "notification-critical-routed",
        channels: ["console", "file", "webhook"],
        externalChannels: ["webhook"],
      },
    });
    expect(result.plan.skippedChannels).toContainEqual({
      channel: "wechat",
      reason: "external_disabled",
    });
    expect(calls).toEqual([
      "console:notification-critical-routed",
      "file:notification-critical-routed",
      "webhook:notification-critical-routed",
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
    expect(JSON.stringify(auditEvents)).not.toContain("sk-test-secret");
  });
});

function fakeNotifier(
  channel: "console" | "file" | "webhook" | "wechat",
  calls: string[],
): NotificationRouterNotifier {
  return {
    notify(event: NotificationEvent): NotificationDeliveryResult {
      calls.push(`${channel}:${event.eventId}`);

      return notificationDeliveryResultSchema.parse({
        eventId: event.eventId,
        channel,
        status: "sent",
        deliveredAt,
        output: `${channel} sent ${event.eventId}`,
      });
    },
  };
}

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "notification-router-001",
    occurredAt,
    severity: "warning",
    source: {
      type: "risk",
      id: "risk-engine",
    },
    target: {
      type: "symbol",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
    },
    summary: "Router warning for paper position.",
    recommendedAction: "Review manually.",
    auditEventId: "audit-source-001",
    correlationId: "correlation-001",
    channels: ["console"],
    metadata: {
      liveTrading: false,
      brokerConnected: false,
    },
    ...overrides,
  });
}
