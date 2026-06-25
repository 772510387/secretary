import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
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
  type WeChatBridgeContext,
  type WeChatBridgeDependencies,
} from "../../src/app/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
} from "../../src/domain/portfolio/index.js";
import { asToolCallingProvider } from "../../src/domain/brain/index.js";
import {
  MockBrainProvider,
  TencentQuoteProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  createPortfolioMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import { buildLivePaperAgentTools } from "./build-context.js";
import { executeAgentAction } from "./agent-actions.js";

const positionsSchema = z.array(positionSchema);

/**
 * Personal-WeChat bridge runner (wechaty). Scans a QR to log a (preferably
 * secondary) WeChat account in, routes inbound DMs to the same `runAgentTurn`
 * brain the CLI uses, and replies in chat.
 *
 * wechaty is loaded dynamically so the repo carries no heavy/finicky dependency
 * until you actually run this. Owner allowlist gates destructive ops; the model
 * never executes tools and no real broker is involved. Groups are not supported.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const memoryDir = config.storage.memoryDir;
  const allowlist = config.wechat.allowedUsers;

  if (!config.wechat.puppet) {
    throw new WeChatBotError(
      "未配置 wechaty puppet。请设 WECHATY_PUPPET（如 wechaty-puppet-wcferry / wechaty-puppet-padlocal）并安装对应包。",
    );
  }

  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const researchRunner =
    config.research.provider === "trading_agents_cn" ? createResearchRunner(config) : undefined;
  const toolProvider = asToolCallingProvider(brainProvider);
  const agentTools = toolProvider
    ? buildLivePaperAgentTools({
        config,
        memoryDir,
        executePaperOps: (command) => executeAgentAction({ type: "paper_ops", ...command }, { config, memoryDir }),
      })
    : undefined;
  const state = createWeChatBridgeState();

  const loadContext = async (): Promise<WeChatBridgeContext> => {
    const paths = createPortfolioMemoryPaths(memoryDir);
    const account = readAccount(paths.accountPath);
    const positions = readPositions(paths.positionsPath);
    const prices = await fetchPrices(positions);
    return { account, positions, prices };
  };
  const loadPortfolio = () => {
    const paths = createPortfolioMemoryPaths(memoryDir);
    return { account: readAccount(paths.accountPath), positions: readPositions(paths.positionsPath) };
  };
  const executeAction = (action: AgentAction): Promise<string> =>
    executeAgentAction(action, { config, memoryDir });

  const { WechatyBuilder } = await loadWechaty();
  const puppet = await loadPuppetInstance(config.wechat.puppet, config.wechat.puppetToken);
  const bot = WechatyBuilder.build({ name: "secretary-wechat", puppet });

  bot.on("scan", (qrcode: string, status: number) => {
    console.log(
      `请用微信扫码登录（status ${status}）：https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`,
    );
  });
  bot.on("login", (user: unknown) => {
    console.log(`✅ 已登录：${String(user)}`);
    console.log(
      allowlist.length > 0
        ? `owner 白名单：${allowlist.join(", ")}（仅这些人可下危险指令）`
        : "未配置 owner 白名单：所有人可问答，但危险操作（清库/建账户）已禁用。设 WECHAT_ALLOWED_USERS 开启。",
    );
  });

  bot.on("message", async (msg: WeChatyMessageLike) => {
    try {
      if (msg.self()) {
        return;
      }
      if (msg.room?.()) {
        return; // groups are not supported
      }

      const text = (msg.text?.() ?? "").trim();

      if (!text) {
        return;
      }

      const talker = msg.talker();
      const peerId = String(talker.id);
      const peerName = talker.name?.() ?? "";
      const isOwner =
        allowlist.length > 0 && (allowlist.includes(peerId) || allowlist.includes(peerName));
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
          await msg.say(note);
        },
      };

      const reply = await runWeChatBridgeTurn({ peerId, text }, deps, state);
      await msg.say(reply.reply);
    } catch (error) {
      console.error(`处理消息出错：${error instanceof Error ? error.message : String(error)}`);
      try {
        await msg.say(describeTurnError(error));
      } catch {
        // ignore secondary failure
      }
    }
  });

  await bot.start();
  console.log("Secretary 微信助手已启动，等待扫码 / 消息……（Ctrl+C 退出）");
}

interface WeChatyMessageLike {
  self(): boolean;
  room?: () => unknown;
  text?: () => string;
  talker(): { id: string; name?: () => string };
  say(text: string): Promise<unknown>;
}

interface WechatyModuleLike {
  WechatyBuilder: {
    build(options: Record<string, unknown>): {
      on(event: string, handler: (...args: never[]) => void): void;
      start(): Promise<void>;
    };
  };
}

async function loadWechaty(): Promise<WechatyModuleLike> {
  const moduleName = "wechaty";

  try {
    return (await import(moduleName)) as unknown as WechatyModuleLike;
  } catch {
    throw new WeChatBotError(
      "未安装 wechaty。请先安装：npm i wechaty 及一个 puppet（如 wechaty-puppet-wcferry 或 wechaty-puppet-padlocal）。",
    );
  }
}

/**
 * Loads a puppet package and returns an instance. Some puppets (e.g. wcferry)
 * only have a named export like `PuppetWcferry` with no `default`, which breaks
 * wechaty's string-name resolver — so we instantiate it ourselves and pass the
 * instance to WechatyBuilder.
 */
async function loadPuppetInstance(puppetName: string, token?: string): Promise<unknown> {
  let mod: Record<string, unknown>;

  try {
    mod = (await import(puppetName)) as Record<string, unknown>;
  } catch (error) {
    throw new WeChatBotError(
      `无法加载 puppet 包 ${puppetName}（${error instanceof Error ? error.message : String(error)}）。确认已安装。`,
    );
  }

  const PuppetClass =
    typeof mod.default === "function"
      ? (mod.default as new (options?: unknown) => unknown)
      : (Object.values(mod).find(
          (value): value is new (options?: unknown) => unknown =>
            typeof value === "function" && /Puppet/.test((value as { name?: string }).name ?? ""),
        ));

  if (!PuppetClass) {
    throw new WeChatBotError(`在 ${puppetName} 中找不到 Puppet 类导出。`);
  }

  return token ? new PuppetClass({ token }) : new PuppetClass();
}

async function fetchPrices(
  positions: ReturnType<typeof readPositions>,
): Promise<Record<string, number>> {
  if (positions.length === 0) {
    return {};
  }

  try {
    const provider = new TencentQuoteProvider();
    const quotes = await provider.getQuotes(
      positions.map((p) => ({ symbol: p.symbol, market: p.market, name: p.name })),
    );
    return Object.fromEntries(quotes.map((quote) => [quote.symbol, quote.latestPrice]));
  } catch {
    return {};
  }
}

function readAccount(accountPath: string): Account | undefined {
  try {
    return accountSchema.parse(JSON.parse(readFileSync(accountPath, "utf8")));
  } catch {
    return undefined;
  }
}

function readPositions(positionsPath: string): ReturnType<typeof positionsSchema.parse> {
  try {
    return positionsSchema.parse(JSON.parse(readFileSync(positionsPath, "utf8")));
  } catch {
    return [];
  }
}

export class WeChatBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeChatBotError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof WeChatBotError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
