import { describe, expect, it } from "vitest";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";
import {
  WeComBotNotifier,
  WeComBotNotifierError,
} from "../../src/infrastructure/notification/index.js";
import type {
  WebhookFetchInit,
  WebhookFetchLike,
  WebhookFetchResponse,
} from "../../src/infrastructure/notification/webhook-notifier.js";

const url = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-bot-key";
const now = "2026-06-16T05:00:00.000Z";

describe("WeComBotNotifier", () => {
  it("requires a webhookUrl or key", () => {
    expect(() => new WeComBotNotifier({})).toThrow(WeComBotNotifierError);
  });

  it("requires the url to carry a bot key", () => {
    expect(
      () => new WeComBotNotifier({ webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send" }),
    ).toThrow(/bot key/);
  });

  it("builds the standard url from a bare key", async () => {
    let capturedUrl = "";
    const notifier = new WeComBotNotifier({
      key: "abc123",
      now: () => new Date(now),
      fetchImpl: okFetch((u) => {
        capturedUrl = u;
      }),
    });

    await notifier.notify(makeEvent());

    expect(capturedUrl).toBe(
      "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc123",
    );
  });

  it("sends a markdown message and reports sent on errcode 0", async () => {
    let body: Record<string, unknown> = {};
    const notifier = new WeComBotNotifier({
      webhookUrl: url,
      now: () => new Date(now),
      fetchImpl: okFetch((_u, init) => {
        body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      }),
    });

    const result = await notifier.notify(makeEvent({ severity: "critical" }));

    expect(result).toMatchObject({ channel: "wechat", status: "sent" });
    expect(body.msgtype).toBe("markdown");
    const content = (body.markdown as { content: string }).content;
    expect(content).toContain("SZSE:000636");
    expect(content).toContain("CRITICAL");
  });

  it("skips severities outside the allowlist without calling fetch", async () => {
    let calls = 0;
    const notifier = new WeComBotNotifier({
      webhookUrl: url,
      now: () => new Date(now),
      fetchImpl: okFetch(() => {
        calls += 1;
      }),
    });

    const result = await notifier.notify(makeEvent({ severity: "info" }));

    expect(result.status).toBe("skipped");
    expect(calls).toBe(0);
  });

  it("maps WeCom errcode to a failed result", async () => {
    const notifier = new WeComBotNotifier({
      webhookUrl: url,
      now: () => new Date(now),
      fetchImpl: jsonFetch(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" })),
    });

    const result = await notifier.notify(makeEvent());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("wecom_invalid_webhook");
    expect(result.error).toContain("93000");
  });

  it("de-identifies secrets in the summary and never leaks the bot key", async () => {
    let body: Record<string, unknown> = {};
    const notifier = new WeComBotNotifier({
      webhookUrl: url,
      now: () => new Date(now),
      fetchImpl: okFetch((_u, init) => {
        body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      }),
    });

    const result = await notifier.notify(
      makeEvent({ summary: "leak sk-ABCDEFGH12345678 now" }),
    );
    const content = (body.markdown as { content: string }).content;

    expect(content).not.toContain("sk-ABCDEFGH12345678");
    expect(content).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("test-bot-key");
  });

  it("reports a timeout as a failed result", async () => {
    const notifier = new WeComBotNotifier({
      webhookUrl: url,
      timeoutMs: 1,
      now: () => new Date(now),
      fetchImpl: hangingFetch(),
    });

    const result = await notifier.notify(makeEvent());

    expect(result.status).toBe("failed");
    expect(result.error).toContain("wecom_timeout");
  });
});

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "notification-wecom-test",
    occurredAt: now,
    severity: "warning",
    source: { type: "risk", id: "risk-engine" },
    target: { type: "symbol", symbol: "000636", market: "SZSE", name: "Fenghua" },
    summary: "持仓跌破成本价 8%。",
    recommendedAction: "评估是否触发硬止损。",
    channels: ["wechat"],
    ...overrides,
  });
}

function response(input: {
  ok: boolean;
  status: number;
  statusText?: string;
  text: string;
}): WebhookFetchResponse {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    text: async () => input.text,
  };
}

function okFetch(
  capture: (url: string, init?: WebhookFetchInit) => void,
): WebhookFetchLike {
  return async (u, init) => {
    capture(u, init);
    return response({ ok: true, status: 200, text: JSON.stringify({ errcode: 0, errmsg: "ok" }) });
  };
}

function jsonFetch(text: string): WebhookFetchLike {
  return async () => response({ ok: true, status: 200, text });
}

function hangingFetch(): WebhookFetchLike {
  return async (_u, init) =>
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
