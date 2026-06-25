import type { AppConfig } from "../../src/config/index.js";
import {
  FeishuNotifier,
  type ExternalNotificationNotifier,
} from "../../src/infrastructure/notification/index.js";

/**
 * Proactive Feishu push notifier (opt-in: FEISHU_NOTIFY=1 + app creds + recipients).
 * Wires the {@link FeishuNotifier} to the Lark `im.message.create` API. Null when not
 * configured. Recipients = FEISHU_PUSH_USERS, falling back to FEISHU_ALLOWED_USERS.
 */
export async function createFeishuPushNotifier(config: AppConfig): Promise<FeishuNotifier | null> {
  if (!config.feishu.notify) {
    return null;
  }
  const appId = config.feishu.appId;
  const appSecret = config.feishu.appSecret;
  if (!appId || !appSecret) {
    console.error("FEISHU_NOTIFY=1 但未配置 FEISHU_APP_ID/SECRET，跳过飞书主动推送。");
    return null;
  }
  const recipients =
    config.feishu.pushUsers.length > 0 ? config.feishu.pushUsers : config.feishu.allowedUsers;
  if (recipients.length === 0) {
    console.error(
      "FEISHU_NOTIFY=1 但没有推送对象（FEISHU_PUSH_USERS / FEISHU_ALLOWED_USERS 均为空，open_id），跳过飞书主动推送。",
    );
    return null;
  }

  const lark = await loadLark();
  const client = new lark.Client({ appId, appSecret });
  const sender = async (message: { receiveId: string; text: string }): Promise<void> => {
    await client.im.message.create({
      params: { receive_id_type: "open_id" },
      data: {
        receive_id: message.receiveId,
        msg_type: "text",
        content: JSON.stringify({ text: message.text }),
      },
    });
  };

  return new FeishuNotifier({ sender, recipients });
}

/** Builds the daemon's external push channels: Feishu (opt-in: FEISHU_NOTIFY=1). */
export async function buildDaemonNotifiers(config: AppConfig): Promise<ExternalNotificationNotifier[]> {
  const notifiers: ExternalNotificationNotifier[] = [];
  const feishu = await createFeishuPushNotifier(config);
  if (feishu) {
    notifiers.push(feishu);
  }
  return notifiers;
}

interface LarkPushClientLike {
  im: {
    message: {
      create(args: {
        params: { receive_id_type: string };
        data: { receive_id: string; msg_type: string; content: string };
      }): Promise<unknown>;
    };
  };
}

interface LarkSdkLike {
  Client: new (options: { appId: string; appSecret: string }) => LarkPushClientLike;
}

async function loadLark(): Promise<LarkSdkLike> {
  try {
    return (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSdkLike;
  } catch (error) {
    throw new Error(
      `无法加载飞书 SDK @larksuiteoapi/node-sdk（${error instanceof Error ? error.message : String(error)}），确认已安装。`,
    );
  }
}
