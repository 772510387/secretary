import { describe, expect, it } from "vitest";
import { TtlCache } from "../../src/infrastructure/cache/index.js";

describe("TtlCache", () => {
  it("serves a value while fresh and drops it once expired", () => {
    let clock = 1000;
    const cache = new TtlCache<string>({ ttlMs: 100, now: () => clock });

    cache.set("a", "x");
    expect(cache.get("a")).toBe("x");

    clock += 99; // still inside the 100ms window
    expect(cache.get("a")).toBe("x");

    clock += 1; // expiresAt (1100) <= now (1100) -> expired
    expect(cache.get("a")).toBeUndefined();
  });

  it("getOrCompute computes once within TTL, then recomputes after expiry", async () => {
    let clock = 0;
    const cache = new TtlCache<number>({ ttlMs: 1000, now: () => clock });
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 5;
    };

    expect(await cache.getOrCompute("k", compute)).toBe(5);
    expect(await cache.getOrCompute("k", compute)).toBe(5);
    expect(calls).toBe(1);

    clock += 1000; // expire
    expect(await cache.getOrCompute("k", compute)).toBe(5);
    expect(calls).toBe(2);
  });

  it("collapses concurrent misses for the same key into one computation", async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, now: () => 0 });
    let calls = 0;
    let release!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      release = resolve;
    });
    const compute = () => {
      calls += 1;
      return gate;
    };

    const p1 = cache.getOrCompute("k", compute);
    const p2 = cache.getOrCompute("k", compute);
    release(42);

    expect(await p1).toBe(42);
    expect(await p2).toBe(42);
    expect(calls).toBe(1);
  });

  it("does not cache a failed computation", async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, now: () => 0 });
    let calls = 0;

    await expect(
      cache.getOrCompute("k", async () => {
        calls += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(
      cache.getOrCompute("k", async () => {
        calls += 1;
        return 7;
      }),
    ).resolves.toBe(7);

    expect(calls).toBe(2);
  });

  it("evicts the oldest entry past maxEntries", () => {
    const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 2, now: () => 0 });

    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });
});
