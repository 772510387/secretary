import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  createResearchRunner,
  createWeChatBridgeState,
  describeTurnError,
  runWeChatBridgeTurn,
  type AgentAction,
  type WeChatBridgeDependencies,
} from "../../src/app/index.js";
import { asToolCallingProvider } from "../../src/domain/brain/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  buildBridgeContext,
  buildLivePaperAgentTools,
  readBridgeAccountAndPositions,
} from "./build-context.js";
import { executeAgentAction } from "./agent-actions.js";

/**
 * Feishu (Lark) two-way bot over the official long-connection (WebSocket) mode.
 *
 * Official bot API — no ban risk, and the bot dials out to Feishu, so it works
 * behind a home network with no public IP / tunnel. Inbound DMs are routed to the
 * same `runWeChatBridgeTurn` brain the CLI uses (allowlist + confirmation +
 * routing). The model never executes tools; no real broker.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const memoryDir = config.storage.memoryDir;
  const appId = config.feishu.appId;
  const appSecret = config.feishu.appSecret;

  if (!appId || !appSecret) {
    throw new FeishuBotError(
      "未配置飞书应用：请在 .env 设 FEISHU_APP_ID 和 FEISHU_APP_SECRET（飞书开放平台 -> 自建应用 -> 凭证）。",
    );
  }

  const allowlist = config.feishu.allowedUsers;
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const researchRunner =
    config.research.provider === "trading_agents_cn" ? createResearchRunner(config) : undefined;
  // Agentic chat: when the provider supports tools, the model reads on-demand and may
  // place paper trades itself. Degrades to the read-only ask when it doesn't (e.g. mock).
  const toolProvider = asToolCallingProvider(brainProvider);
  const agentTools = toolProvider
    ? buildLivePaperAgentTools({
        config,
        memoryDir,
        executePaperOps: (command) => executeAgentAction({ type: "paper_ops", ...command }, { config, memoryDir }),
      })
    : undefined;
  const state = createWeChatBridgeState();
  const seenMessageIds = new Set<string>();

  if (researchRunner) {
    console.log("深度分析：已接入 TradingAgents-CN（说『深度分析…』触发，单次数分钟）。");
  }

  const loadContext = (message: string) =>
    buildBridgeContext({ config, memoryDir, question: message });
  const loadPortfolio = () => readBridgeAccountAndPositions(memoryDir);
  const executeAction = (action: AgentAction): Promise<string> =>
    executeAgentAction(action, { config, memoryDir });

  const lark = await loadLark();
  const client = new lark.Client({ appId, appSecret });
  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel?.error ?? 1,
  });

  // Per-peer processing chains. A slow turn must NOT block the dispatcher (or the
  // next inbound message would only get logged/handled after it finishes). We log
  // on arrival, then run the turn off the dispatcher; one peer's messages stay
  // ordered, different peers run concurrently.
  const peerChains = new Map<string, Promise<void>>();

  function enqueueTurn(peerId: string, task: () => Promise<void>): void {
    const previous = peerChains.get(peerId) ?? Promise.resolve();
    const next = previous.then(task, task);
    peerChains.set(peerId, next);
    void next.finally(() => {
      if (peerChains.get(peerId) === next) {
        peerChains.delete(peerId);
      }
    });
  }

  async function handleTurn(input: {
    messageId: string;
    openId: string;
    text: string;
    receivedAt: number;
  }): Promise<void> {
    const { messageId, openId, text, receivedAt } = input;
    const elapsed = (): string => `${Date.now() - receivedAt}ms`;

    try {
      const isOwner = allowlist.length > 0 && allowlist.includes(openId);
      const deps: WeChatBridgeDependencies = {
        brainProvider,
        researchRunner,
        agentTools,
        toolProvider,
        isAllowed: () => allowlist.length === 0 || isOwner,
        allowDestructive: () => isOwner,
        loadContext,
        loadPortfolio,
        executeAction,
        runConfirmedPaperOpsInBackground: true,
        onProgress: async (note) => {
          console.log(`[feishu +${elapsed()}] ${openId} 已路由，开始取数+分析`);
          await reply(client, messageId, note);
        },
      };
      const result = await runWeChatBridgeTurn({ peerId: openId, text }, deps, state);
      console.log(`[feishu +${elapsed()}] ${openId} 回复就绪`);
      await reply(client, messageId, result.reply);
      console.log(`[feishu +${elapsed()}] ${openId} 已发送`);
    } catch (error) {
      console.error(`[feishu] 处理消息出错：${error instanceof Error ? error.message : String(error)}`);
      try {
        await reply(client, messageId, describeTurnError(error));
      } catch {
        // ignore secondary failure
      }
    }
  }

  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": (raw: unknown) => {
      const data = raw as FeishuMessageEvent;
      const message = data.message;
      const messageId = message?.message_id;

      if (!messageId || seenMessageIds.has(messageId)) {
        return;
      }

      rememberMessageId(seenMessageIds, messageId);

      if (message?.chat_type !== "p2p") {
        return; // direct messages only
      }

      const openId = data.sender?.sender_id?.open_id ?? "";

      if (message?.message_type !== "text") {
        void reply(client, messageId, "目前只支持文本消息。").catch(() => undefined);
        return;
      }

      const text = parseFeishuText(message.content);
      // Log the instant the event arrives, before any slow work, so the timeline is honest.
      console.log(`[feishu ${new Date().toISOString()}] from ${openId}: ${text}`);

      if (!text) {
        return;
      }

      enqueueTurn(openId, () => handleTurn({ messageId, openId, text, receivedAt: Date.now() }));
    },
  });

  wsClient.start({ eventDispatcher: dispatcher });

  console.log("✅ 飞书机器人已通过长连接启动，给应用发私聊消息即可对话。(Ctrl+C 退出)");
  console.log(
    allowlist.length > 0
      ? `owner 白名单(open_id)：${allowlist.join(", ")}`
      : "未配置 owner 白名单：所有人可问答，危险操作禁用。你先私聊一次，日志会打印你的 open_id，填进 FEISHU_ALLOWED_USERS 即可开放清库/建账户。",
  );
}

async function reply(client: LarkClientLike, messageId: string, text: string): Promise<void> {
  await client.im.message.reply({
    path: { message_id: messageId },
    data: { content: JSON.stringify({ text }), msg_type: "text" },
  });
}

function parseFeishuText(content: string | undefined): string {
  if (typeof content !== "string") {
    return "";
  }

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function rememberMessageId(seen: Set<string>, messageId: string): void {
  seen.add(messageId);

  if (seen.size > 2000) {
    const oldest = seen.values().next().value;

    if (oldest !== undefined) {
      seen.delete(oldest);
    }
  }
}

interface FeishuMessageEvent {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
}

interface LarkClientLike {
  im: {
    message: {
      reply(args: {
        path: { message_id: string };
        data: { content: string; msg_type: string };
      }): Promise<unknown>;
    };
  };
}

interface LarkSdkLike {
  Client: new (options: { appId: string; appSecret: string }) => LarkClientLike;
  WSClient: new (options: Record<string, unknown>) => {
    start(options: { eventDispatcher: unknown }): unknown;
  };
  EventDispatcher: new (options: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => unknown>): {
      register(handlers: Record<string, (data: unknown) => unknown>): unknown;
    };
  };
  LoggerLevel?: Record<string, number>;
}

async function loadLark(): Promise<LarkSdkLike> {
  const moduleName = "@larksuiteoapi/node-sdk";

  try {
    return (await import(moduleName)) as unknown as LarkSdkLike;
  } catch (error) {
    throw new FeishuBotError(
      `无法加载飞书 SDK @larksuiteoapi/node-sdk（${error instanceof Error ? error.message : String(error)}）。确认已安装。`,
    );
  }
}

export class FeishuBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeishuBotError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof FeishuBotError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
