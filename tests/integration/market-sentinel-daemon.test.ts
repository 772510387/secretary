import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import type { SchedulerTaskContext } from "../../src/infrastructure/scheduler/index.js";
import { createMarketSentinelDaemon } from "../../src/runtime/index.js";
import { main as runMarketSentinelDaemonScript } from "../../scripts/dev/market-sentinel-daemon.js";

const tempRoots: string[] = [];
const inSession = new Date("2026-06-12T01:30:00.000Z");

describe("MarketSentinel daemon runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();

    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("starts, protects against duplicate start, and stops gracefully with audit metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(inSession);

    const memoryDir = createTempMemoryDir();
    const contexts: SchedulerTaskContext[] = [];
    const daemon = createMarketSentinelDaemon({
      memoryDir,
      clock: { now: () => inSession },
      intervalMs: 10,
      outsideSessionIntervalMs: 1000,
      idGenerator: createIdGenerator(),
      task: (context) => {
        contexts.push(context);
      },
    });

    const start = daemon.start();
    const duplicate = daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    const stop = await daemon.stop("test-stop");

    expect(start).toMatchObject({
      status: "started",
      jobId: "market-sentinel-dev",
      auditLogPath: auditPath(memoryDir),
    });
    expect(duplicate).toMatchObject({
      status: "already_started",
      jobId: "market-sentinel-dev",
      auditLogPath: auditPath(memoryDir),
    });
    expect(stop).toMatchObject({
      status: "stopped",
      jobId: "market-sentinel-dev",
      auditLogPath: auditPath(memoryDir),
      shutdownHookCount: 1,
      failedShutdownHookCount: 0,
    });
    expect(daemon.isStarted()).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      jobId: "market-sentinel-dev",
      scheduledAt: inSession.toISOString(),
    });

    const events = readAuditEvents(memoryDir);
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.result)).toEqual([
      "success",
      "skipped",
      "success",
      "success",
    ]);
    expect(events.map((event) => event.action)).toEqual([
      "config",
      "config",
      "validate",
      "config",
    ]);
    expect(events.every((event) => event.actor.type === "scheduler")).toBe(true);
    expect(events.every((event) => event.subject.type === "scheduler")).toBe(true);
    expect(events[2]?.metadata).toMatchObject({
      jobId: "market-sentinel-dev",
      mode: "development",
      taskMode: "mock",
      liveTrading: false,
      brokerConnected: false,
      brainProvider: "mock",
      networkAllowed: false,
      directExecutionAllowed: false,
      scheduledAt: inSession.toISOString(),
      beijingDate: "2026-06-12",
    });

    expect(daemon.health()).toMatchObject({
      runtimeId: "market-sentinel-daemon",
      status: "stopped",
      stoppedAt: inSession.toISOString(),
      heartbeatAt: inSession.toISOString(),
      tasks: [
        {
          taskId: "market-sentinel-dev",
          status: "stopped",
          lastStoppedAt: inSession.toISOString(),
        },
      ],
      metadata: {
        liveTrading: false,
        brokerConnected: false,
        networkAllowed: false,
        event: "stopped",
      },
    });
    expect(existsSync(path.join(memoryDir, "logs", "runtime-health.json"))).toBe(true);
    expect(existsSync(path.join(memoryDir, "logs", "heartbeat-2026-06-12.jsonl"))).toBe(true);
  });

  it("writes failure audit metadata when the daemon task throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(inSession);

    const memoryDir = createTempMemoryDir();
    const daemon = createMarketSentinelDaemon({
      memoryDir,
      clock: { now: () => inSession },
      intervalMs: 10,
      outsideSessionIntervalMs: 1000,
      idGenerator: createIdGenerator(),
      task: () => {
        throw new Error(
          `mock daemon callback failed apiKey=sk-live-secret-123456 accountId=paper-main ${"x".repeat(600)}`,
        );
      },
    });

    daemon.start();
    await vi.advanceTimersByTimeAsync(0);
    await daemon.stop("test-stop");

    const failure = readAuditEvents(memoryDir).find((event) => event.result === "failure");

    expect(failure).toMatchObject({
      action: "error",
      severity: "warning",
      message: "MarketSentinel daemon task failed",
      metadata: {
        errorType: "Error",
        liveTrading: false,
        brokerConnected: false,
        networkAllowed: false,
      },
    });
    expect(JSON.stringify(failure)).not.toContain("stack");
    expect(JSON.stringify(failure)).not.toContain("sk-live-secret");
    expect(JSON.stringify(failure)).not.toContain("paper-main");

    const health = daemon.health();
    expect(health).toMatchObject({
      status: "stopped",
      tasks: [
        {
          taskId: "market-sentinel-dev",
          status: "stopped",
          lastError: {
            errorType: "Error",
            occurredAt: inSession.toISOString(),
          },
        },
      ],
    });
    expect(JSON.stringify(health)).toContain("[redacted]");
    expect(JSON.stringify(health)).toContain("[truncated]");
    expect(JSON.stringify(health)).not.toContain("sk-live-secret");
    expect(JSON.stringify(health)).not.toContain("paper-main");
  });

  it("starts and stops through the development script run window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(inSession);

    // Keep the script's optional WeCom status push off so this test never hits the network.
    const previousWecomNotify = process.env.WECOM_NOTIFY;
    process.env.WECOM_NOTIFY = "0";

    const memoryDir = createTempMemoryDir();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const run = runMarketSentinelDaemonScript([
      "--memory-dir",
      memoryDir,
      "--run-ms",
      "1",
      "--interval-ms",
      "10",
      "--outside-session-interval-ms",
      "10",
      "--allow-outside-session",
      "--at",
      inSession.toISOString(),
    ]);

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    await run;

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      status: "ok",
      mode: "market-sentinel-daemon",
      liveTrading: false,
      brainProvider: "mock",
      brokerConnected: false,
      networkAllowed: false,
      start: {
        status: "started",
      },
      stop: {
        status: "stopped",
      },
    });
    expect(existsSync(auditPath(memoryDir))).toBe(true);
    expect(readAuditEvents(memoryDir).some((event) => event.message === "MarketSentinel daemon task completed"))
      .toBe(true);

    if (previousWecomNotify === undefined) {
      delete process.env.WECOM_NOTIFY;
    } else {
      process.env.WECOM_NOTIFY = previousWecomNotify;
    }
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-market-sentinel-daemon-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function auditPath(memoryDir: string): string {
  return path.join(memoryDir, "logs", "audit-2026-06-12.jsonl");
}

function readAuditEvents(memoryDir: string) {
  return readFileSync(auditPath(memoryDir), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => auditEventSchema.parse(JSON.parse(line)));
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `test-${id}`;
  };
}
