import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlarmJobRegistry,
  JobLock,
  MarketSentinelRunner,
  TradingDayScheduler,
  toBeijingDateTime,
  type Clock,
} from "../../src/infrastructure/scheduler/index.js";
import { createSchedulerRuntime } from "../../src/runtime/index.js";

describe("Beijing scheduler clock and trading session", () => {
  it("converts instants into Beijing date time", () => {
    const beijingTime = toBeijingDateTime(new Date("2026-06-11T16:00:00.000Z"));

    expect(beijingTime).toMatchObject({
      timezone: "Asia/Shanghai",
      date: "2026-06-12",
      time: "00:00:00",
      isoLocal: "2026-06-12T00:00:00.000+08:00",
      dayOfWeek: 5,
      minuteOfDay: 0,
    });
  });

  it("recognizes A-share trading sessions in Beijing time", () => {
    const scheduler = new TradingDayScheduler();

    expect(scheduler.isMarketOpen(new Date("2026-06-12T01:30:00.000Z"))).toBe(true);
    expect(scheduler.isMarketOpen(new Date("2026-06-12T03:45:00.000Z"))).toBe(false);
    expect(scheduler.isMarketOpen(new Date("2026-06-12T05:00:00.000Z"))).toBe(true);
    expect(scheduler.isMarketOpen(new Date("2026-06-12T07:00:00.000Z"))).toBe(false);
    expect(scheduler.isMarketOpen(new Date("2026-06-13T01:30:00.000Z"))).toBe(false);
  });
});

describe("AlarmJobRegistry", () => {
  it("runs fixed Beijing alarm jobs once per slot", async () => {
    const registry = new AlarmJobRegistry();
    const calls: string[] = [];

    registry.register({
      jobId: "pre-market-plan",
      beijingTime: "08:30",
      weekdaysOnly: true,
      task: (context) => {
        calls.push(`${context.beijingTime.date} ${context.beijingTime.time}`);
      },
    });

    const first = await registry.runDue(new Date("2026-06-12T00:30:05.000Z"));
    const duplicate = await registry.runDue(new Date("2026-06-12T00:30:30.000Z"));
    const weekend = await registry.runDue(new Date("2026-06-13T00:30:05.000Z"));
    const nextWeekday = await registry.runDue(new Date("2026-06-15T00:30:05.000Z"));

    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("completed");
    expect(duplicate).toEqual([]);
    expect(weekend).toEqual([]);
    expect(nextWeekday).toHaveLength(1);
    expect(calls).toEqual([
      "2026-06-12 08:30:05",
      "2026-06-15 08:30:05",
    ]);
  });
});

describe("JobLock", () => {
  it("prevents the same job from reentering", async () => {
    const lock = new JobLock();
    const deferred = createDeferred<void>();
    let entered = 0;
    const scheduledAt = new Date("2026-06-12T01:30:00.000Z");

    const first = lock.runExclusive(
      "market-sentinel",
      async () => {
        entered += 1;
        await deferred.promise;
      },
      scheduledAt,
    );
    const second = await lock.runExclusive(
      "market-sentinel",
      () => {
        entered += 1;
      },
      scheduledAt,
    );

    expect(second.status).toBe("skipped_locked");
    expect(entered).toBe(1);

    deferred.resolve(undefined);
    expect((await first).status).toBe("completed");

    const third = await lock.runExclusive(
      "market-sentinel",
      () => {
        entered += 1;
      },
      scheduledAt,
    );

    expect(third.status).toBe("completed");
    expect(entered).toBe(2);
  });
});

describe("MarketSentinelRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips sentinel checks outside trading sessions and runs inside sessions", async () => {
    let calls = 0;
    const runner = new MarketSentinelRunner({
      task: () => {
        calls += 1;
      },
    });

    const outside = await runner.triggerOnce(new Date("2026-06-12T03:45:00.000Z"));
    const inside = await runner.triggerOnce(new Date("2026-06-12T01:31:00.000Z"));

    expect(outside.status).toBe("skipped_outside_session");
    expect(inside.status).toBe("completed");
    expect(calls).toBe(1);
  });

  it("runs as a loop without reentry and stops gracefully", async () => {
    vi.useFakeTimers();

    const clock: Clock = {
      now: () => new Date("2026-06-12T01:30:00.000Z"),
    };
    const runtime = createSchedulerRuntime({ clock });
    const deferred = createDeferred<void>();
    let calls = 0;
    const runner = runtime.createMarketSentinelRunner({
      intervalMs: 10,
      outsideSessionIntervalMs: 1000,
      task: async () => {
        calls += 1;
        await deferred.promise;
      },
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(calls).toBe(1);
    expect(runner.pendingRunCount()).toBeGreaterThan(0);

    const shutdown = runtime.shutdown.shutdown("test");
    let finished = false;
    void shutdown.then(() => {
      finished = true;
    });
    await Promise.resolve();

    expect(runner.isStarted()).toBe(false);
    expect(finished).toBe(false);

    deferred.resolve(undefined);
    const result = await shutdown;

    expect(finished).toBe(true);
    expect(result.hooks).toMatchObject([
      {
        name: "runner:market-sentinel",
        status: "completed",
      },
    ]);
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
