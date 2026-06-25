import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  AgentRouterError,
  PaperAccountInitializationError,
  classifyAgentIntent,
  runAgentTurn,
  type AgentAction,
  type AgentTurnInput,
  type AskWebSearchContext,
} from "../../src/app/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
} from "../../src/domain/portfolio/index.js";
import {
  BrainProviderError,
  MockBrainProvider,
  SearchProviderError,
  TavilySearchProvider,
  TencentQuoteProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  StorageError,
  createPortfolioMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import { executeAgentAction } from "./agent-actions.js";

const NETWORK_FLAG = "ASK_NETWORK";
const positionsSchema = z.array(positionSchema);

interface AgentCliOptions {
  help: boolean;
  yes: boolean;
  web: boolean;
  memoryDir?: string;
  message: string;
}

/**
 * Natural-language command entry point.
 *
 * Routes one message to a backend operation (capabilities / reset / seed) or a
 * model answer over the live DB. Destructive ops require --yes. This is the same
 * "brain" a future WeChat bridge would call — only the transport differs.
 */
export async function main(argv: string[]): Promise<void> {
  const cli = parseArgs(argv);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const paths = createPortfolioMemoryPaths(memoryDir);
  const account = readAccount(paths.accountPath);
  const positions = readPositions(paths.positionsPath);
  const now = new Date().toISOString();

  const intent = classifyAgentIntent(cli.message, now).intent;
  const needsModel = intent === "ask";
  const wantOnline = needsModel && config.brain.provider !== "mock";

  if (wantOnline && process.env[NETWORK_FLAG] !== "1") {
    console.error(
      `这是一个需要模型回答的问题。设 ${NETWORK_FLAG}=1 放行真实模型调用，或把 BRAIN_PROVIDER 设为 mock。`,
    );
    process.exit(2);
    return;
  }

  const brainProvider = wantOnline ? createBrainProvider(config.brain) : new MockBrainProvider();
  const prices = wantOnline ? await fetchPrices(positions) : {};
  const webSearch = cli.web && wantOnline ? await runWebSearch(config, cli.message) : undefined;

  const turnInput: AgentTurnInput = {
    message: cli.message,
    confirmed: cli.yes,
    account,
    positions,
    prices,
    webSearch,
    now,
  };
  const result = await runAgentTurn(turnInput, { brainProvider });

  if (result.action) {
    const summary = await executeAction(result.action, config, memoryDir);
    console.log(result.reply);
    console.log(`   ${summary}`);
    return;
  }

  console.log(result.reply);

  if (result.requiresConfirmation) {
    console.log("   （确认后请加 --yes 重发同一句话。）");
  }
}

function executeAction(
  action: AgentAction,
  config: ReturnType<typeof loadConfig>,
  memoryDir: string,
): Promise<string> {
  return executeAgentAction(action, { config, memoryDir });
}

async function runWebSearch(
  config: ReturnType<typeof loadConfig>,
  query: string,
): Promise<AskWebSearchContext | undefined> {
  if (config.search.provider !== "tavily" || !config.search.tavilyApiKey) {
    console.error("--web 已开启，但未配置 Tavily（SEARCH_PROVIDER=tavily + TAVILY_API_KEY），跳过搜索。");
    return undefined;
  }

  try {
    const provider = new TavilySearchProvider({ apiKey: config.search.tavilyApiKey });
    const result = await provider.search(query, { maxResults: config.search.maxResults });
    console.log(`—— 联网检索（Tavily，命中 ${result.results.length} 条）——`);
    for (const item of result.results) {
      console.log(`  • ${item.title || item.url}　${item.url}`);
    }
    return {
      query: result.query,
      answer: result.answer,
      results: result.results.map((item) => ({ title: item.title, url: item.url, snippet: item.snippet })),
    };
  } catch (error) {
    if (error instanceof SearchProviderError) {
      console.error(`（联网检索失败，改为仅用账户上下文：${error.message}）`);
      return undefined;
    }

    throw error;
  }
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

function parseArgs(argv: string[]): AgentCliOptions {
  const options: AgentCliOptions = { help: false, yes: false, web: false, message: "" };
  const parts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--web":
        options.web = true;
        break;
      case "--memory-dir":
        options.memoryDir = argv[index + 1];
        index += 1;
        break;
      default:
        if (arg !== undefined) {
          parts.push(arg);
        }
    }
  }

  options.message = parts.join(" ").trim();

  if (!options.help && options.message === "") {
    throw new AgentRouterError('请给一句话，例如：npm run agent -- "项目现在有什么能力？"');
  }

  return options;
}

function printHelp(): void {
  console.log(`agent - 自然语言指令大脑（清库/建账户/问能力/杂项问答）

用法:
  npm run agent -- "项目现在有什么能力和流程？"
  npm run agent -- "清除模拟盘数据" --yes
  npm run agent -- "帮我构建一个5万的模拟盘账户" --yes
  ASK_NETWORK=1 npm run agent -- "我仓位重不重？有什么风险？"
  ASK_NETWORK=1 npm run agent -- --web "最近有什么影响我持仓的政策？"

说明:
  确定性识别意图：能力咨询 / 清库重置 / 构建账户 / 杂项问答。
  危险操作（清库、建账户）必须加 --yes 确认。问答类需 ASK_NETWORK=1。
  这是模拟盘；按红线不接真实券商、不自动实盘、模型不能执行任何工具。
`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof AgentRouterError ||
      error instanceof ConfigLoadError ||
      error instanceof BrainProviderError ||
      error instanceof PaperAccountInitializationError ||
      error instanceof StorageError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
