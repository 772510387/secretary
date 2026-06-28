import { describe, expect, it } from "vitest";
import {
  classifyExternalPush,
  notificationEventSchema,
  shouldPushToExternalChannels,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";

function event(overrides: Partial<NotificationEvent>): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "evt-test",
    occurredAt: "2026-06-24T01:30:00.000Z",
    severity: "info",
    source: { type: "cerebellum", id: "alarm-matrix" },
    target: { type: "system" },
    summary: "test",
    recommendedAction: "test",
    channels: ["feishu"],
    metadata: {},
    ...overrides,
  });
}

describe("operator push gate", () => {
  it("pushes an executed paper operation (8% hard stop)", () => {
    const ntf = event({
      severity: "warning",
      source: { type: "cerebellum", id: "market-sentinel" },
      target: { type: "symbol", symbol: "000636", market: "SZSE", name: "风华高科" },
      metadata: { eventType: "position_stop_loss", autoClosed: true },
    });

    expect(classifyExternalPush(ntf)).toBe("executed_operation");
    expect(shouldPushToExternalChannels(ntf)).toBe(true);
  });

  it("pushes a funnel auto-paper execution report", () => {
    const ntf = event({
      source: { type: "scheduler", id: "daily-funnel" },
      metadata: { funnel: true, autoPaper: true },
    });

    expect(classifyExternalPush(ntf)).toBe("executed_operation");
  });

  it("pushes a systemic index red-line", () => {
    const ntf = event({
      severity: "critical",
      source: { type: "cerebellum", id: "index-risk-radar" },
    });

    expect(classifyExternalPush(ntf)).toBe("redline");
    expect(shouldPushToExternalChannels(ntf)).toBe(true);
  });

  it("pushes cooldown-bounded sentinel warning red-lines", () => {
    const ntf = event({
      severity: "warning",
      source: { type: "cerebellum", id: "market-sentinel" },
      target: { type: "symbol", symbol: "000636", market: "SZSE", name: "风华高科" },
      metadata: { eventType: "previous_high_breakout" },
    });

    expect(classifyExternalPush(ntf)).toBe("redline");
    expect(shouldPushToExternalChannels(ntf)).toBe(true);
  });

  it("pushes scheduled node reports and funnel summaries", () => {
    expect(shouldPushToExternalChannels(event({ source: { type: "cerebellum", id: "alarm-matrix" } }))).toBe(true);
    expect(shouldPushToExternalChannels(event({ source: { type: "scheduler", id: "daily-funnel" }, metadata: { funnel: true } }))).toBe(true);
    expect(shouldPushToExternalChannels(event({ source: { type: "cerebellum", id: "deep-review" } }))).toBe(true);
  });

  it("suppresses 3s volume-price radar observations", () => {
    const ntf = event({
      severity: "warning",
      source: { type: "cerebellum", id: "volume-price-radar" },
      target: { type: "symbol", symbol: "000100", market: "SZSE", name: "TCL科技" },
      metadata: { labels: ["volume_surge"] },
    });

    expect(classifyExternalPush(ntf)).toBeNull();
    expect(shouldPushToExternalChannels(ntf)).toBe(false);
  });

  it("pushes the 3s sentinel's price red-lines", () => {
    const ntf = event({
      severity: "warning",
      source: { type: "cerebellum", id: "market-sentinel" },
      target: { type: "symbol", symbol: "000636", market: "SZSE", name: "风华高科" },
      metadata: { eventType: "price_drop" },
    });

    expect(shouldPushToExternalChannels(ntf)).toBe(true);
  });

  it("pushes warning index radar red-lines but suppresses watch-level observations", () => {
    expect(
      shouldPushToExternalChannels(
        event({ severity: "warning", source: { type: "cerebellum", id: "index-risk-radar" } }),
      ),
    ).toBe(true);
    expect(
      shouldPushToExternalChannels(
        event({ severity: "watch", source: { type: "cerebellum", id: "market-sentinel" } }),
      ),
    ).toBe(false);
  });
});
