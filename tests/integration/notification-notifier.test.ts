import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";
import {
  ConsoleNotifier,
  FileNotifier,
  WebhookNotifier,
  createNotificationLogPath,
  type WebhookFetchInit,
  type WebhookFetchLike,
  type WebhookFetchResponse,
} from "../../src/infrastructure/notification/index.js";

const tempRoots: string[] = [];
const occurredAt = "2026-06-14T02:00:00.000Z";
const deliveredAt = "2026-06-14T02:00:01.000Z";

describe("notification notifiers", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("formats console notifications through an injected sink", () => {
    const lines: string[] = [];
    const notifier = new ConsoleNotifier({
      sink: (line) => lines.push(line),
      now: () => new Date(deliveredAt),
    });
    const result = notifier.notify(makeEvent());

    expect(result).toMatchObject({
      eventId: "notification-001",
      channel: "console",
      status: "sent",
      deliveredAt,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("WARNING");
    expect(lines[0]).toContain("action=Review position manually.");
  });

  it("appends file notifications as JSONL with redaction and backups", () => {
    const memoryDir = createTempMemoryDir();
    const filePath = createNotificationLogPath(path.join(memoryDir, "logs"), occurredAt);
    const notifier = new FileNotifier({
      filePath,
      now: () => new Date(deliveredAt),
    });
    const event = makeEvent({
      summary: "Warning with token=abc123",
      recommendedAction: "Do not expose apiKey=sk-test-secret-123456",
      metadata: {
        apiKey: "sk-test-secret-123456",
        nested: {
          password: "plain-text",
          safe: "kept",
        },
      },
    });

    const first = notifier.notify(event);
    const second = notifier.notify({
      ...event,
      eventId: "notification-002",
    });
    const stored = readJsonLines(filePath);

    expect(first).toMatchObject({
      eventId: "notification-001",
      channel: "file",
      status: "sent",
      filePath,
    });
    expect(second.backupPath).toBeDefined();
    expect(existsSync(second.backupPath!)).toBe(true);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      eventId: "notification-001",
      severity: "warning",
      summary: "Warning with token=[redacted]",
      recommendedAction: "Do not expose apiKey=[redacted]",
      metadata: {
        apiKey: "[redacted]",
        nested: {
          password: "[redacted]",
          safe: "kept",
        },
      },
    });
    expect(JSON.stringify(stored)).not.toContain("sk-test-secret");
    expect(JSON.stringify(stored)).not.toContain("plain-text");
  });

  it("sends webhook notifications with a redacted body through mock fetch", async () => {
    let capturedUrl = "";
    let capturedInit: WebhookFetchInit | undefined;
    const notifier = new WebhookNotifier({
      url: "https://webhook.example.local/secretary",
      headers: {
        Authorization: "Bearer webhook-secret-token",
      },
      now: () => new Date(deliveredAt),
      fetchImpl: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;

        return webhookResponse({
          ok: true,
          status: 200,
          text: JSON.stringify({
            ok: true,
            deliveryId: "delivery-001",
            message: "accepted token=raw-response-token",
          }),
        });
      },
    });
    const event = makeEvent({
      channels: ["webhook"],
      summary: "Warning with token=abc123",
      recommendedAction: "Do not expose apiKey=sk-test-secret-123456",
      metadata: {
        apiKey: "sk-test-secret-123456",
      },
    });

    const result = await notifier.notify(event);
    const body = JSON.parse(capturedInit?.body ?? "{}") as Record<string, unknown>;

    expect(capturedUrl).toBe("https://webhook.example.local/secretary");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer webhook-secret-token",
    });
    expect(result).toMatchObject({
      eventId: "notification-001",
      channel: "webhook",
      status: "sent",
      deliveredAt,
    });
    expect(result.output).toContain("deliveryId=delivery-001");
    expect(result.output).toContain("token=[redacted]");
    expect(JSON.stringify(body)).not.toContain("abc123");
    expect(JSON.stringify(body)).not.toContain("sk-test-secret");
    expect(JSON.stringify(result)).not.toContain("raw-response-token");
    expect(JSON.stringify(result)).not.toContain("webhook-secret-token");
  });

  it.each([
    [401, "Unauthorized", "webhook_auth_failed"],
    [403, "Forbidden", "webhook_auth_failed"],
    [429, "Too Many Requests", "webhook_rate_limited"],
    [500, "Internal Server Error", "webhook_server_error"],
    [503, "Service Unavailable", "webhook_server_error"],
  ])("maps webhook HTTP %s to a failed delivery", async (status, statusText, code) => {
    const notifier = new WebhookNotifier({
      url: "https://webhook.example.local/secretary",
      now: () => new Date(deliveredAt),
      fetchImpl: async () =>
        webhookResponse({
          ok: false,
          status,
          statusText,
          headers: {
            "Retry-After": "3",
          },
          text: JSON.stringify({
            message: `${code} apiKey=sk-response-secret-123456`,
          }),
        }),
    });

    const result = await notifier.notify(makeEvent({
      channels: ["webhook"],
    }));

    expect(result).toMatchObject({
      eventId: "notification-001",
      channel: "webhook",
      status: "failed",
      deliveredAt,
    });
    expect(result.error).toContain(code);
    if (status === 429) {
      expect(result.error).toContain("retryAfterMs=3000");
    }
    expect(JSON.stringify(result)).not.toContain("sk-response-secret");
  });

  it("returns failed deliveries on timeout and bad webhook responses", async () => {
    const timedOut = await new WebhookNotifier({
      url: "https://webhook.example.local/secretary",
      timeoutMs: 1,
      now: () => new Date(deliveredAt),
      fetchImpl: hangingFetch(),
    }).notify(makeEvent({
      channels: ["webhook"],
    }));
    const badJson = await new WebhookNotifier({
      url: "https://webhook.example.local/secretary",
      now: () => new Date(deliveredAt),
      fetchImpl: async () =>
        webhookResponse({
          ok: true,
          status: 200,
          text: "not-json token=bad-response-secret",
        }),
    }).notify(makeEvent({
      channels: ["webhook"],
    }));
    const explicitBad = await new WebhookNotifier({
      url: "https://webhook.example.local/secretary",
      now: () => new Date(deliveredAt),
      fetchImpl: async () =>
        webhookResponse({
          ok: true,
          status: 200,
          text: JSON.stringify({
            ok: false,
            message: "rejected secret=bad-response-secret",
          }),
        }),
    }).notify(makeEvent({
      channels: ["webhook"],
    }));

    expect(timedOut).toMatchObject({
      status: "failed",
      error: "webhook_timeout: request timed out after 1ms",
    });
    expect(badJson.status).toBe("failed");
    expect(badJson.error).toContain("webhook_bad_response");
    expect(explicitBad.status).toBe("failed");
    expect(explicitBad.error).toContain("webhook_bad_response");
    expect(JSON.stringify([badJson, explicitBad])).not.toContain("bad-response-secret");
  });

  const smokeEnabled =
    process.env.WEBHOOK_NOTIFIER_NETWORK === "1" &&
    typeof process.env.WEBHOOK_NOTIFIER_URL === "string" &&
    process.env.WEBHOOK_NOTIFIER_URL.trim().length > 0;
  const smokeIt = smokeEnabled ? it : it.skip;

  smokeIt("can send a webhook notification when explicitly enabled", async () => {
    const notifier = new WebhookNotifier({
      url: process.env.WEBHOOK_NOTIFIER_URL!,
      timeoutMs: 10_000,
    });

    const result = await notifier.notify(makeEvent({
      eventId: "notification-webhook-smoke",
      channels: ["webhook"],
      summary: "Webhook notifier explicit smoke.",
      recommendedAction: "No broker action.",
    }));

    expect(result.status).toBe("sent");
  }, 15_000);
});

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "notification-001",
    occurredAt,
    severity: "warning",
    source: {
      type: "cerebellum",
      id: "market-sentinel",
    },
    target: {
      type: "symbol",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
    },
    summary: "Paper stop-loss warning.",
    recommendedAction: "Review position manually.",
    auditEventId: "audit-001",
    correlationId: "event-001",
    channels: ["console", "file"],
    metadata: {
      liveTrading: false,
      brokerConnected: false,
    },
    ...overrides,
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-notification-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function webhookResponse(input: {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  text: string;
}): WebhookFetchResponse {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    headers: {
      get(name: string): string | null {
        return input.headers?.[name] ?? input.headers?.[name.toLowerCase()] ?? null;
      },
    },
    text: async () => input.text,
  };
}

function hangingFetch(): WebhookFetchLike {
  return async (_url, init) =>
    new Promise<WebhookFetchResponse>((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };

      if (init?.signal?.aborted) {
        rejectAbort();
        return;
      }

      init?.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
}
