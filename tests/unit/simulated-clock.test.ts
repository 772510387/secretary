import { describe, expect, it } from "vitest";
import { SimulatedClock } from "../../src/infrastructure/scheduler/index.js";
import { toCerebellumBeijingTime } from "../../src/domain/cerebellum/index.js";

describe("SimulatedClock", () => {
  it("positions at a Beijing wall instant that round-trips through toCerebellumBeijingTime", () => {
    const clock = new SimulatedClock();
    clock.setToBeijingInstant("2026-06-20", "15:00");

    const beijing = toCerebellumBeijingTime(clock.now());
    expect(beijing.date).toBe("2026-06-20");
    expect(beijing.hour).toBe(15);
    expect(beijing.minute).toBe(0);
  });

  it("handles the 00:00 midnight edge — resolves to that day, not the day before", () => {
    const clock = new SimulatedClock();
    clock.setToBeijingInstant("2026-06-20", "00:00");

    const beijing = toCerebellumBeijingTime(clock.now());
    expect(beijing.date).toBe("2026-06-20");
    expect(beijing.minuteOfDay).toBe(0);
  });

  it("advanceDays moves the underlying instant by whole days, preserving the wall time", () => {
    const clock = new SimulatedClock();
    clock.setToBeijingInstant("2026-06-20", "09:30");
    clock.advanceDays(1);

    const beijing = toCerebellumBeijingTime(clock.now());
    expect(beijing.date).toBe("2026-06-21");
    expect(beijing.hour).toBe(9);
    expect(beijing.minute).toBe(30);
  });

  it("now() returns a fresh Date each call (no shared mutable reference)", () => {
    const clock = new SimulatedClock();
    clock.setToBeijingInstant("2026-06-20", "10:00");
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(toCerebellumBeijingTime(clock.now()).date).toBe("2026-06-20");
  });
});
