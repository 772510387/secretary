import { describe, expect, it } from "vitest";
import {
  runtimeHealthSnapshotSchema,
  sanitizeRuntimeHealthMetadata,
  summarizeRuntimeError,
} from "../../src/infrastructure/storage/index.js";

const occurredAt = "2026-06-15T01:30:00.000Z";

describe("runtime health metadata", () => {
  it("validates health snapshots without sensitive runtime details", () => {
    const snapshot = runtimeHealthSnapshotSchema.parse({
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
        liveTrading: false,
        brokerConnected: false,
        networkAllowed: false,
      },
    });

    expect(snapshot).toMatchObject({
      runtimeId: "market-sentinel-daemon",
      status: "running",
      metadata: {
        liveTrading: false,
        brokerConnected: false,
      },
    });
  });

  it("redacts secret and account-like metadata and truncates long text", () => {
    const sanitized = sanitizeRuntimeHealthMetadata({
      apiKey: "sk-test-secret-123456",
      brokerAccountId: "paper-main",
      nested: {
        token: "raw-token",
        message: `Research body ${"x".repeat(500)} token=abc123`,
      },
      text: "authorization=Bearer-secret sk-live-secret-123456",
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized.apiKey).toBe("[redacted]");
    expect(sanitized.brokerAccountId).toBe("[redacted]");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[truncated]");
    expect(serialized).not.toContain("sk-test-secret");
    expect(serialized).not.toContain("paper-main");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("abc123");
  });

  it("summarizes runtime errors without stack, secrets, or long body", () => {
    const error = new Error(
      `apiKey=sk-live-secret-123456 accountId=paper-main ${"x".repeat(800)}`,
    );
    const summary = summarizeRuntimeError(error, occurredAt);
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      errorType: "Error",
      occurredAt,
    });
    expect(summary.message.length).toBeLessThanOrEqual(500);
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[truncated]");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("paper-main");
    expect(serialized).not.toContain("stack");
  });
});
