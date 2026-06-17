import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeHealthStore,
  runtimeHeartbeatSchema,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const occurredAt = "2026-06-15T01:30:00.000Z";

describe("RuntimeHealthStore", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("writes health snapshots and heartbeat metadata without leaking sensitive details", () => {
    const memoryDir = createTempMemoryDir();
    const store = new RuntimeHealthStore({
      memoryDir,
      now: () => new Date(occurredAt),
      idGenerator: createIdGenerator(),
    });

    const health = store.writeHealth({
      runtimeId: "market-sentinel-daemon",
      status: "running",
      updatedAt: occurredAt,
      startedAt: occurredAt,
      heartbeatAt: occurredAt,
      tasks: [
        {
          taskId: "market-sentinel-dev",
          status: "running",
          lastStartedAt: occurredAt,
          lastHeartbeatAt: occurredAt,
        },
      ],
      metadata: {
        event: "started",
        apiKey: "sk-test-secret-123456",
        accountId: "paper-main",
        note: "safe heartbeat metadata only",
      },
    });
    const heartbeat = store.appendHeartbeat({
      runtimeId: "market-sentinel-daemon",
      taskId: "market-sentinel-dev",
      status: "running",
      occurredAt,
      metadata: {
        event: "started",
        token: "raw-token",
      },
    });

    expect(health.filePath).toBe(path.join(memoryDir, "logs", "runtime-health.json"));
    expect(heartbeat.filePath).toBe(path.join(memoryDir, "logs", "heartbeat-2026-06-15.jsonl"));
    expect(existsSync(health.filePath)).toBe(true);
    expect(existsSync(heartbeat.filePath)).toBe(true);
    expect(store.readHealth()).toMatchObject({
      runtimeId: "market-sentinel-daemon",
      status: "running",
      metadata: {
        event: "started",
        apiKey: "[redacted]",
        accountId: "[redacted]",
      },
    });

    const heartbeatEvents = readHeartbeatEvents(heartbeat.filePath);
    expect(heartbeatEvents).toHaveLength(1);
    expect(heartbeatEvents[0]).toMatchObject({
      heartbeatId: "heartbeat-health-001",
      runtimeId: "market-sentinel-daemon",
      status: "running",
      metadata: {
        token: "[redacted]",
      },
    });

    const serialized = `${readFileSync(health.filePath, "utf8")}\n${readFileSync(
      heartbeat.filePath,
      "utf8",
    )}`;
    expect(serialized).not.toContain("sk-test-secret");
    expect(serialized).not.toContain("paper-main");
    expect(serialized).not.toContain("raw-token");
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-runtime-health-store-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `health-${String(id).padStart(3, "0")}`;
  };
}

function readHeartbeatEvents(filePath: string) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => runtimeHeartbeatSchema.parse(JSON.parse(line)));
}
