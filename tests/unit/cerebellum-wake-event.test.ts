import { describe, expect, it, vi } from "vitest";
import {
  buildCerebellumWakeEvent,
  dispatchCerebellumWake,
  wakeEventToSteeringMessage,
  type CerebellumWakeEvent,
} from "../../src/domain/cerebellum/index.js";

const occurredAt = "2026-06-24T01:30:00.000Z";

describe("buildCerebellumWakeEvent", () => {
  it("defaults a red-line to wake-now + critical", () => {
    const event = buildCerebellumWakeEvent({
      source: "market_sentinel",
      kind: "redline",
      text: "600519 触及 8% 硬止损，已平仓",
      occurredAt,
    });
    expect(event.wakeMode).toBe("now");
    expect(event.severity).toBe("critical");
    expect(event.wakeId).toMatch(/^wake-market_sentinel-/);
  });

  it("defaults a scheduled node to next-idle + info and keeps the alarm type", () => {
    const event = buildCerebellumWakeEvent({
      source: "alarm_matrix",
      kind: "scheduled_node",
      text: "08:30 数据已备齐，请做盘前计划",
      occurredAt,
      alarmType: "pre_market_plan",
      beijingTime: "08:30",
      dataReady: true,
    });
    expect(event.wakeMode).toBe("next-idle");
    expect(event.severity).toBe("info");
    expect(event.alarmType).toBe("pre_market_plan");
    expect(event.dataReady).toBe(true);
  });
});

describe("dispatchCerebellumWake", () => {
  it("a red-line steers an in-flight turn AND wakes the brain, always auditing", async () => {
    const event = buildCerebellumWakeEvent({
      source: "market_sentinel",
      kind: "redline",
      text: "已触发止损",
      occurredAt,
    });
    const onWake = vi.fn();
    const steer = vi.fn();
    const wakeBrain = vi.fn(async () => undefined);

    const result = await dispatchCerebellumWake(event, { onWake, steer, wakeBrain });

    expect(onWake).toHaveBeenCalledOnce();
    expect(steer).toHaveBeenCalledOnce();
    expect(wakeBrain).toHaveBeenCalledOnce();
    expect(result.steered).toBe(true);
    expect(result.woke).toBe(true);
    expect(result.routed).toBe("wake_brain");
  });

  it("a scheduled node only wakes the brain (no steering)", async () => {
    const event = buildCerebellumWakeEvent({
      source: "alarm_matrix",
      kind: "scheduled_node",
      text: "做收盘复盘",
      occurredAt,
    });
    const steer = vi.fn();
    const wakeBrain = vi.fn(async () => undefined);

    const result = await dispatchCerebellumWake(event, { steer, wakeBrain });

    expect(steer).not.toHaveBeenCalled();
    expect(wakeBrain).toHaveBeenCalledOnce();
    expect(result.steered).toBe(false);
    expect(result.woke).toBe(true);
  });
});

describe("wakeEventToSteeringMessage", () => {
  it("renders a system steering message tagged with source/kind/time", () => {
    const event: CerebellumWakeEvent = buildCerebellumWakeEvent({
      source: "market_sentinel",
      kind: "redline",
      text: "已平仓",
      occurredAt,
      beijingTime: "13:45",
    });
    const message = wakeEventToSteeringMessage(event);
    expect(message.role).toBe("system");
    expect(message.content).toContain("market_sentinel/redline@13:45");
    expect(message.content).toContain("已平仓");
  });
});
