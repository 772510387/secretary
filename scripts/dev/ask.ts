import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  AskPortfolioError,
  runAskOnce,
} from "../../src/app/index.js";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import {
  BrainProviderError,
  MockBrainProvider,
  SearchProviderError,
  TavilySearchProvider,
  TencentQuoteProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import { createPortfolioMemoryPaths } from "../../src/infrastructure/storage/index.js";
import type { AskWebSearchContext } from "../../src/app/index.js";

const NETWORK_FLAG = "ASK_NETWORK";
const positionsSchema = z.array(positionSchema);

interface AskCliOptions {
  help: boolean;
  offline: boolean;
  web: boolean;
  memoryDir?: string;
  question: string;
}

/**
 * Ask the configured brain model about the current paper account.
 *
 * Reads the real paper DB (account + positions), optionally marks positions to
 * market with live Tencent quotes, then asks the model. Real providers require
 * ASK_NETWORK=1 (explicit opt-in). With BRAIN_PROVIDER=mock it runs fully offline.
 */
export async function main(argv: string[]): Promise<void> {
  const cli = parseArgs(argv);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const paths = createPortfolioMemoryPaths(cli.memoryDir ?? config.storage.memoryDir);
  const account = readAccount(paths.accountPath);
  const positions = readPositions(paths.positionsPath);

  const wantOnline = !cli.offline && config.brain.provider !== "mock";

  if (wantOnline && process.env[NETWORK_FLAG] !== "1") {
    console.error(
      [
        `Refusing to call the real ${config.brain.provider} model without explicit opt-in.`,
        `Set ${NETWORK_FLAG}=1 to allow the outbound call, or pass --offline / BRAIN_PROVIDER=mock to run offline.`,
      ].join(" "),
    );
    process.exit(2);
    return;
  }

  const brainProvider = wantOnline ? createBrainProvider(config.brain) : new MockBrainProvider();
  const prices = wantOnline ? await fetchPrices(positions) : {};
  const webSearch = cli.web && wantOnline ? await runWebSearch(config, cli.question) : undefined;

  if (cli.web && !wantOnline) {
    console.error("--web 需要联网（真实大脑 + 搜索）；离线/mock 模式下忽略。");
  }

  const result = await runAskOnce(
    {
      question: cli.question,
      account,
      positions,
      prices,
      webSearch,
      metadata: { source: "ask-cli" },
    },
    { brainProvider },
  );

  const v = result.valuation;
  console.log("");
  console.log(`问题：${result.question}`);
  console.log("—— 账户快照（来自模拟盘 DB）——");
  console.log(`账户：${v.accountId}　可用现金：${v.cash.available}　冻结：${v.cash.frozen}`);
  console.log(
    `总资产：${v.totalAssets}　持仓市值：${v.totalPositionMarketValue}　浮盈亏：${v.totalUnrealizedPnl}　仓位：${(v.investedRatio * 100).toFixed(2)}%`,
  );

  if (v.positions.length === 0) {
    console.log("持仓：无");
  } else {
    for (const p of v.positions) {
      console.log(
        `  ${p.market}:${p.symbol} ${p.name}　${p.quantity}股　成本${p.costPrice}　现价${p.latestPrice}　浮盈亏${p.unrealizedPnl}(${(p.unrealizedPnlRatio * 100).toFixed(2)}%)`,
      );
    }
  }

  console.log(`—— 模型回答（${result.provider}/${result.model}，置信度 ${result.confidence}）——`);
  console.log(result.answer);
  console.log("");
  console.log(`（行情已${result.pricesAvailable ? "" : "未"}盯市；本回答不可直接下单，任何买卖建议须人工复核。）`);
}

async function runWebSearch(
  config: ReturnType<typeof loadConfig>,
  query: string,
): Promise<AskWebSearchContext | undefined> {
  if (config.search.provider !== "tavily") {
    console.error("--web 已开启，但 SEARCH_PROVIDER 不是 tavily，跳过搜索。");
    return undefined;
  }

  if (!config.search.tavilyApiKey) {
    console.error("--web 已开启，但未配置 TAVILY_API_KEY，跳过搜索。");
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
      results: result.results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.snippet,
      })),
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
  } catch (error) {
    console.error(`（行情拉取失败，改用成本价估值：${error instanceof Error ? error.message : String(error)}）`);
    return {};
  }
}

function readAccount(accountPath: string): ReturnType<typeof accountSchema.parse> {
  try {
    return accountSchema.parse(JSON.parse(readFileSync(accountPath, "utf8")));
  } catch (error) {
    throw new AskPortfolioError(
      `Failed to read paper account at ${accountPath}. Run "npm run seed:paper" first. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function readPositions(positionsPath: string): ReturnType<typeof positionsSchema.parse> {
  try {
    return positionsSchema.parse(JSON.parse(readFileSync(positionsPath, "utf8")));
  } catch {
    // Missing/empty positions file means a freshly seeded account with no holdings.
    return [];
  }
}

function parseArgs(argv: string[]): AskCliOptions {
  const options: AskCliOptions = { help: false, offline: false, web: false, question: "" };
  const questionParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--offline":
        options.offline = true;
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
          questionParts.push(arg);
        }
    }
  }

  options.question =
    questionParts.join(" ").trim() || "现在我的账户和持仓是什么情况？给我一个简要点评和风险提示。";
  return options;
}

function printHelp(): void {
  console.log(`ask - 问模型当前模拟盘账户/持仓情况

用法:
  ASK_NETWORK=1 npm run ask -- "我现在仓位重不重？有什么风险？"
  ASK_NETWORK=1 npm run ask -- --web "查一下最近有什么影响我持仓的政策或新闻？"
  npm run ask -- --offline "离线预览（用 mock 模型，不联网）"

说明:
  读取 memory/portfolio 的真实模拟盘 DB，可选用腾讯实时行情盯市，
  再交给配置的大模型回答。真实 provider 必须 ASK_NETWORK=1 显式放行。
  --web：后端先用 Tavily 联网检索，把结果作为上下文喂给模型（需 SEARCH_PROVIDER=tavily
  和 TAVILY_API_KEY）。模型仍不能执行任何工具、不下单、不写账户。
`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof ConfigLoadError ||
      error instanceof AskPortfolioError ||
      error instanceof BrainProviderError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
