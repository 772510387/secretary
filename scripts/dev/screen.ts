import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigLoadError, loadConfig } from "../../src/config/index.js";
import {
  buildWatchlistFromScreen,
  type BuildWatchlistFromScreenResult,
} from "../../src/app/index.js";
import {
  screenCriteriaSchema,
  screenUniverse,
  type ScreenCriteria,
  type WatchlistCategory,
  type WatchlistPriority,
} from "../../src/domain/market/index.js";
import {
  CachingUniverseProvider,
  EastmoneyUniverseProvider,
  FallbackUniverseProvider,
  FileUniverseCacheStore,
  SinaUniverseProvider,
  UniverseProviderError,
  type UniverseCacheStatus,
} from "../../src/infrastructure/providers/index.js";
import { WatchlistMemoryStore } from "../../src/infrastructure/storage/index.js";

/**
 * Build a watchlist pool from a DETERMINISTIC screen of the real A-share universe
 * (Eastmoney) — the data-backed answer to "沉淀100支自选股池", instead of letting
 * the model invent codes. Read-only on the market; only writes the watchlist file.
 */
export async function main(args: string[]): Promise<void> {
  const cli = parseArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  // cache → (Eastmoney primary → Sina fallback) → stale-cache fallback.
  const provider = new CachingUniverseProvider({
    inner: new FallbackUniverseProvider(
      [new EastmoneyUniverseProvider(), new SinaUniverseProvider()],
      {
        onAttemptError: ({ index, error }) => {
          const source = index === 0 ? "东方财富" : "新浪";
          console.log(`（${source}取数失败，转下一个源：${error instanceof Error ? error.message : String(error)}）`);
        },
      },
    ),
    store: new FileUniverseCacheStore(path.join(config.storage.memoryDir, "market", "cache")),
    refresh: cli.refresh,
    onStatus: logCacheStatus,
  });

  // Presets: default = a broad 100-name pool by liquidity; --potential = a tighter momentum shortlist.
  const preset = cli.potential
    ? { category: "potential_stocks" as WatchlistCategory, priority: "high" as WatchlistPriority, criteria: { limit: 10, sortBy: "changePct", minAmount: 2e8, minTurnoverRate: 1 } as Partial<ScreenCriteria> }
    : { category: "watchlist_today" as WatchlistCategory, priority: "medium" as WatchlistPriority, criteria: { limit: 100, sortBy: "amount", minAmount: 1e8 } as Partial<ScreenCriteria> };

  const criteria: Partial<ScreenCriteria> = {
    ...preset.criteria,
    ...(cli.limit !== undefined ? { limit: cli.limit } : {}),
    ...(cli.sort !== undefined ? { sortBy: cli.sort } : {}),
    ...(cli.minAmount !== undefined ? { minAmount: cli.minAmount } : {}),
    ...(cli.minPrice !== undefined ? { minPrice: cli.minPrice } : {}),
    ...(cli.maxPrice !== undefined ? { maxPrice: cli.maxPrice } : {}),
  };
  const category = cli.category ?? preset.category;

  if (cli.dryRun) {
    const resolved = screenCriteriaSchema.parse(criteria);
    const universe = await provider.getUniverse({
      sortBy: resolved.sortBy,
      descending: resolved.descending,
      mainBoardOnly: resolved.mainBoardOnly,
      targetCount: resolved.limit,
    });
    const screened = screenUniverse(universe, resolved);
    console.log(`取到 ${universe.length} 只候选 → 筛选出 ${screened.length} 只（${category}，未落库 --dry-run）：`);
    printTable(screened.slice(0, 30));
    if (screened.length > 30) {
      console.log(`… 其余 ${screened.length - 30} 只略。`);
    }
    return;
  }

  const store = new WatchlistMemoryStore({ memoryDir: config.storage.memoryDir });
  const result = await buildWatchlistFromScreen({
    provider,
    writer: store,
    category,
    priority: preset.priority,
    criteria,
    mode: cli.merge ? "merge" : "replace",
  });

  printResult(result);
}

interface ScreenCliOptions {
  help: boolean;
  potential: boolean;
  dryRun: boolean;
  merge: boolean;
  refresh: boolean;
  limit?: number;
  sort?: ScreenCriteria["sortBy"];
  minAmount?: number;
  minPrice?: number;
  maxPrice?: number;
  category?: WatchlistCategory;
}

function parseArgs(args: string[]): ScreenCliOptions {
  const options: ScreenCliOptions = { help: false, potential: false, dryRun: false, merge: false, refresh: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = (): string => {
      const value = args[index + 1];
      index += 1;
      if (value === undefined || value.startsWith("--")) {
        throw new ScreenCliError(`${arg} 需要一个值`);
      }
      return value;
    };

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--potential":
        options.potential = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--merge":
        options.merge = true;
        break;
      case "--refresh":
      case "--no-cache":
        options.refresh = true;
        break;
      case "--limit":
        options.limit = parsePositiveInt(next(), "--limit");
        break;
      case "--sort":
        options.sort = parseSort(next());
        break;
      case "--min-amount":
        options.minAmount = parsePositiveNumber(next(), "--min-amount");
        break;
      case "--min-price":
        options.minPrice = parsePositiveNumber(next(), "--min-price");
        break;
      case "--max-price":
        options.maxPrice = parsePositiveNumber(next(), "--max-price");
        break;
      case "--category":
        options.category = parseCategory(next());
        break;
      default:
        throw new ScreenCliError(`未知参数：${arg}`);
    }
  }

  return options;
}

function printResult(result: BuildWatchlistFromScreenResult): void {
  console.log(
    `✅ 已${result.mode === "replace" ? "重建" : "合并到"} ${result.category}：` +
      `全市场 ${result.universeSize} 只 → 落库 ${result.written} 只。`,
  );
  console.log(`文件：${result.write.filePath}`);
  console.log("前 10 名（按筛选排名）：");
  printTable(
    [...result.entries]
      .map((entry) => ({
        symbol: entry.symbol,
        market: entry.market,
        name: entry.name,
        latestPrice: numOrUndefined(entry.metadata.latestPrice),
        changePct: numOrUndefined(entry.metadata.changePct),
        turnoverRate: numOrUndefined(entry.metadata.turnoverRate),
        amount: numOrUndefined(entry.metadata.amount),
        rank: numOrUndefined(entry.metadata.rank),
      }))
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
      .slice(0, 10),
  );
}

interface PrintableStock {
  symbol: string;
  market: string;
  name: string;
  latestPrice?: number;
  changePct?: number;
  turnoverRate?: number;
  amount?: number;
}

function printTable(rows: readonly PrintableStock[]): void {
  for (const row of rows) {
    const price = row.latestPrice !== undefined ? row.latestPrice.toFixed(2) : "-";
    const chg = row.changePct !== undefined ? `${row.changePct.toFixed(2)}%` : "-";
    const turn = row.turnoverRate !== undefined ? `${row.turnoverRate.toFixed(1)}%` : "-";
    const amt = row.amount !== undefined ? `${(row.amount / 1e8).toFixed(1)}亿` : "-";
    console.log(`  ${row.market} ${row.symbol} ${row.name}\t价 ${price}\t涨跌 ${chg}\t换手 ${turn}\t成交额 ${amt}`);
  }
}

function logCacheStatus(status: UniverseCacheStatus): void {
  const mins = status.ageMs !== undefined ? Math.max(1, Math.round(status.ageMs / 60_000)) : undefined;
  if (status.source === "fresh-cache") {
    console.log(`（命中 ${mins} 分钟前的缓存，未联网；要强制重拉加 --refresh）`);
  } else if (status.source === "stale-cache-fallback") {
    console.log(`⚠️ 行情源暂时取不到数据，已回退到 ${mins} 分钟前的缓存快照（结果可能略旧）。`);
  } else {
    console.log("（已联网拉取最新行情并缓存）");
  }
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parsePositiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ScreenCliError(`${name} 必须是正整数`);
  }
  return parsed;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ScreenCliError(`${name} 必须是正数`);
  }
  return parsed;
}

function parseSort(value: string): ScreenCriteria["sortBy"] {
  const allowed = ["changePct", "turnoverRate", "amount", "marketCap", "latestPrice"] as const;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ScreenCliError(`--sort 需为：${allowed.join(", ")}`);
  }
  return value as ScreenCriteria["sortBy"];
}

function parseCategory(value: string): WatchlistCategory {
  const allowed = ["watchlist_today", "watchlist_long_term", "potential_stocks"] as const;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ScreenCliError(`--category 需为：${allowed.join(", ")}`);
  }
  return value as WatchlistCategory;
}

function printHelp(): void {
  console.log(`screen - 从真实全 A 股池里确定性筛选并沉淀自选股

用法:
  npm run screen                          # 沉淀今日池 watchlist_today：主板成交额前 100，落库
  npm run screen -- --potential           # 沉淀潜力股 potential_stocks：涨幅前 10（带流动性下限）
  npm run screen -- --dry-run             # 只打印筛选结果，不落库（验证用）
  npm run screen -- --limit 50 --sort turnoverRate
  npm run screen -- --min-amount 500000000 --min-price 3 --max-price 100
  npm run screen -- --merge               # 合并进现有池而不是重建
  npm run screen -- --refresh             # 强制重拉行情（默认 10 分钟内复用缓存）

可选 --sort: changePct | turnoverRate | amount | marketCap | latestPrice
默认只选沪深主板、排除 ST/*ST/退市/停牌；这是确定性筛选，不调模型、不下单、不接券商。
只按需拉取（服务端排序，约 2-3 页）并缓存 10 分钟；行情源限流时自动回退到缓存快照。
`);
}

export class ScreenCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ScreenCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }

    if (error instanceof UniverseProviderError) {
      console.error(
        `行情源（东方财富）暂时取不到全市场数据：${error.message}\n` +
          "多为请求过于频繁被限流或网络波动，稍等几分钟再跑 npm run screen 即可。",
      );
      process.exit(1);
    }

    throw error;
  });
}
