import { describe, expect, it } from "vitest";
import { DailyBudget } from "../../src/runtime/index.js";

describe("DailyBudget", () => {
  it("allows consumption up to the limit, then denies", () => {
    const budget = new DailyBudget({ brain: 2 }, () => new Date("2026-06-21T01:00:00.000Z"));
    expect(budget.tryConsume("brain")).toBe(true);
    expect(budget.tryConsume("brain")).toBe(true);
    expect(budget.tryConsume("brain")).toBe(false); // 3rd exceeds limit 2
    expect(budget.remaining("brain")).toBe(0);
  });

  it("denied consumption spends nothing", () => {
    const budget = new DailyBudget({ research: 1 }, () => new Date("2026-06-21T01:00:00.000Z"));
    expect(budget.tryConsume("research")).toBe(true);
    expect(budget.tryConsume("research")).toBe(false);
    expect(budget.tryConsume("research")).toBe(false); // still 0 remaining, no underflow
    expect(budget.snapshot().used.research).toBe(1);
  });

  it("treats an unset limit as unlimited", () => {
    const budget = new DailyBudget({}, () => new Date("2026-06-21T01:00:00.000Z"));
    for (let i = 0; i < 100; i += 1) {
      expect(budget.tryConsume("brain")).toBe(true);
    }
    expect(budget.remaining("search")).toBe(Number.POSITIVE_INFINITY);
  });

  it("resets counters at the Beijing day boundary", () => {
    let now = new Date("2026-06-21T15:00:00.000Z"); // 23:00 Beijing on the 21st
    const budget = new DailyBudget({ brain: 1 }, () => now);
    expect(budget.tryConsume("brain")).toBe(true);
    expect(budget.tryConsume("brain")).toBe(false);

    now = new Date("2026-06-21T16:30:00.000Z"); // 00:30 Beijing on the 22nd — new day
    expect(budget.tryConsume("brain")).toBe(true); // budget reset
    expect(budget.snapshot().date).toBe("2026-06-22");
  });
});
