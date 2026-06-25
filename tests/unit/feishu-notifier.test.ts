import { describe, expect, it, vi } from "vitest";
import { FeishuNotifier, type FeishuPushMessage } from "../../src/infrastructure/notification/index.js";
import { notificationEventSchema, type NotificationEvent } from "../../src/domain/notification/index.js";

const now = "2026-06-22T13:00:00.000Z";

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: "evt-1",
    occurredAt: now,
    severity: "warning",
    source: { type: "scheduler", id: "cerebellum" },
    target: { type: "symbol", symbol: "000001", market: "SZSE", name: "平安银行" },
    summary: "盘前计划：关注回调风险",
    recommendedAction: "等回踩再考虑，勿追高（待人工复核）",
    channels: ["feishu"],
    ...overrides,
  });
}

describe("FeishuNotifier", () => {
  it("sends a redacted summary to every recipient", async () => {
    const sends: FeishuPushMessage[] = [];
    const notifier = new FeishuNotifier({
      sender: async (message) => {
        sends.push(message);
      },
      recipients: ["ou_owner_a", "ou_owner_b"],
      now: () => new Date(now),
    });

    const result = await notifier.notify(makeEvent());

    expect(result.status).toBe("sent");
    expect(result.channel).toBe("feishu");
    expect(sends.map((s) => s.receiveId)).toEqual(["ou_owner_a", "ou_owner_b"]);
    expect(sends[0]!.text).toContain("盘前计划");
    expect(sends[0]!.text).toContain("000001");
    expect(sends[0]!.text).toContain("WARNING");
  });

  it("skips a severity outside the allowlist", async () => {
    const sender = vi.fn(async () => {});
    const notifier = new FeishuNotifier({
      sender,
      recipients: ["ou_owner_a"],
      severityAllowlist: ["critical"],
      now: () => new Date(now),
    });

    const result = await notifier.notify(makeEvent({ severity: "info" }));

    expect(result.status).toBe("skipped");
    expect(sender).not.toHaveBeenCalled();
  });

  it("skips when no recipients are configured", async () => {
    const sender = vi.fn(async () => {});
    const notifier = new FeishuNotifier({ sender, recipients: [], now: () => new Date(now) });

    const result = await notifier.notify(makeEvent());

    expect(result.status).toBe("skipped");
    expect(sender).not.toHaveBeenCalled();
  });

  it("reports failed (without throwing) when every send fails", async () => {
    const notifier = new FeishuNotifier({
      sender: async () => {
        throw new Error("lark down");
      },
      recipients: ["ou_owner_a"],
      now: () => new Date(now),
    });

    const result = await notifier.notify(makeEvent());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("feishu_send_failed");
  });

  it("still reports sent when at least one recipient succeeds (partial)", async () => {
    let calls = 0;
    const notifier = new FeishuNotifier({
      sender: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("first failed");
        }
      },
      recipients: ["ou_a", "ou_b"],
      now: () => new Date(now),
    });

    const result = await notifier.notify(makeEvent());
    expect(result.status).toBe("sent");
    expect(result.output).toContain("partial");
  });

  it("redacts secrets in the pushed text", async () => {
    let pushed = "";
    const notifier = new FeishuNotifier({
      sender: async (message) => {
        pushed = message.text;
      },
      recipients: ["ou_a"],
      now: () => new Date(now),
    });

    await notifier.notify(makeEvent({ summary: "token=sk-abcdefgh1234 泄漏测试" }));
    expect(pushed).not.toContain("sk-abcdefgh1234");
  });
});
