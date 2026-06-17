import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  WeComBotNotifier,
  WeComBotNotifierError,
} from "../../src/infrastructure/notification/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";

const SEND_FLAG = "WECHAT_NETWORK_SEND";

/**
 * One-shot WeCom group-bot test. Sends a single de-identified test notification
 * to the configured bot webhook so you can confirm messages arrive in your group.
 *
 * Sends a real outbound message, so it is gated behind WECHAT_NETWORK_SEND=1 and
 * requires WECOM_BOT_WEBHOOK_URL in the environment / .env.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const webhookUrl = config.notification.wecomBotWebhookUrl;

  if (!webhookUrl) {
    console.error(
      "WECOM_BOT_WEBHOOK_URL is not set. Add your WeCom group-bot webhook URL to .env first.",
    );
    process.exit(1);
    return;
  }

  if (process.env[SEND_FLAG] !== "1") {
    console.error(
      `Refusing to send a real WeCom message without explicit opt-in. Set ${SEND_FLAG}=1 to send.`,
    );
    process.exit(2);
    return;
  }

  const notifier = new WeComBotNotifier({ webhookUrl });
  const event: NotificationEvent = notificationEventSchema.parse({
    eventId: `wechat-test-${Date.now()}`,
    occurredAt: new Date().toISOString(),
    severity: "warning",
    source: { type: "system", id: "wechat-test" },
    target: { type: "system" },
    summary: "这是一条来自 Secretary 的企业微信测试消息。",
    recommendedAction: "确认你能在群里收到这条提醒即可，无需任何操作。",
    channels: ["wechat"],
  });

  const result = await notifier.notify(event);

  console.log(
    JSON.stringify(
      {
        mode: "wechat-test",
        status: result.status,
        channel: result.channel,
        output: result.output,
        error: result.error,
      },
      null,
      2,
    ),
  );

  if (result.status !== "sent") {
    process.exit(1);
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigLoadError || error instanceof WeComBotNotifierError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
