import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  WatchlistMemoryStore,
  StorageError,
} from "../../src/infrastructure/storage/index.js";
import type {
  WatchlistCategory,
  WatchlistEntryInput,
  WatchlistPriority,
} from "../../src/domain/market/index.js";

const CATEGORIES: readonly WatchlistCategory[] = [
  "watchlist_today",
  "watchlist_long_term",
  "potential_stocks",
];
const PRIORITIES: readonly WatchlistPriority[] = ["low", "medium", "high"];

/**
 * Manage the watchlist pools used by the live sentinel (`--live`).
 *
 * Local, offline DB editing only — no network, no broker, no model. High-priority
 * entries are scanned intraday by the daemon for surge/drop / near-observe alerts.
 */
export async function main(argv: string[]): Promise<void> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const config = loadConfig();
  const store = new WatchlistMemoryStore({ memoryDir: config.storage.memoryDir });

  if (command === "add") {
    handleAdd(store, argv.slice(1));
    return;
  }

  if (command === "list") {
    handleList(store, argv.slice(1));
    return;
  }

  throw new WatchlistCliError(`Unknown command: ${command} (use add | list)`);
}

function handleAdd(store: WatchlistMemoryStore, argv: string[]): void {
  const flags = parseFlags(argv);
  const [symbol, ...nameParts] = flags.positional;
  const name = nameParts.join(" ").trim();

  if (!symbol || !/^\d{6}$/.test(symbol)) {
    throw new WatchlistCliError(`symbol must be a 6-digit A-share code (got: ${symbol ?? "missing"})`);
  }

  if (!name) {
    throw new WatchlistCliError("name is required: watchlist add <symbol> <name>");
  }

  const category = parseCategory(flags.options.category ?? "watchlist_today");
  const priority = parsePriority(flags.options.priority ?? "high");
  const entry: WatchlistEntryInput = {
    symbol,
    name,
    priority,
    reason: flags.options.reason ?? "manual cli add",
    source: "watchlist-cli",
    ...(flags.options.market ? { market: parseMarket(flags.options.market) } : {}),
    ...(flags.options.observe ? { observePrice: parsePrice(flags.options.observe) } : {}),
  };

  const result = store.importEntries(category, [entry]);

  console.log(
    `✅ 已加入自选股池「${category}」：${symbol} ${name}（优先级 ${priority}${entry.observePrice ? `，观察价 ${entry.observePrice}` : ""}）`,
  );
  console.log(`   当前该池共 ${result.entryCount} 只。high 优先级会被 --live 盘中盯市。`);
}

function handleList(store: WatchlistMemoryStore, argv: string[]): void {
  const flags = parseFlags(argv);
  const categories = flags.options.category ? [parseCategory(flags.options.category)] : CATEGORIES;

  for (const category of categories) {
    const snapshot = store.readCategory(category);
    console.log(`—— ${category}（${snapshot.entries.length} 只）——`);

    if (snapshot.entries.length === 0) {
      console.log("  (空)");
      continue;
    }

    for (const entry of snapshot.entries) {
      console.log(
        `  [${entry.priority}] ${entry.market}:${entry.symbol} ${entry.name}` +
          `${entry.observePrice ? `　观察价 ${entry.observePrice}` : ""}　${entry.reason}`,
      );
    }
  }
}

interface ParsedFlags {
  positional: string[];
  options: Record<string, string | undefined>;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const options: Record<string, string | undefined> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg !== undefined && arg.startsWith("--")) {
      options[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  return { positional, options };
}

function parseCategory(value: string): WatchlistCategory {
  if (!CATEGORIES.includes(value as WatchlistCategory)) {
    throw new WatchlistCliError(`--category must be one of: ${CATEGORIES.join(" | ")}`);
  }

  return value as WatchlistCategory;
}

function parsePriority(value: string): WatchlistPriority {
  if (!PRIORITIES.includes(value as WatchlistPriority)) {
    throw new WatchlistCliError(`--priority must be one of: ${PRIORITIES.join(" | ")}`);
  }

  return value as WatchlistPriority;
}

function parseMarket(value: string): "SSE" | "SZSE" {
  if (value !== "SSE" && value !== "SZSE") {
    throw new WatchlistCliError("--market must be SSE or SZSE");
  }

  return value;
}

function parsePrice(value: string): number {
  const price = Number(value);

  if (!Number.isFinite(price) || price <= 0) {
    throw new WatchlistCliError(`--observe must be a positive number (got: ${value})`);
  }

  return price;
}

function printHelp(): void {
  console.log(`watchlist - 管理自选股池（供 --live 盘中盯市）

用法:
  npm run watchlist -- add 000636 风华高科 --priority high --observe 70
  npm run watchlist -- add 600519 贵州茅台 --category potential_stocks --reason "白马观察"
  npm run watchlist -- list
  npm run watchlist -- list --category watchlist_today

分类: ${CATEGORIES.join(" | ")}
优先级: ${PRIORITIES.join(" | ")}（只有 high 会被 --live 盘中盯市）

本地写 memory/market/watchlists，不联网、不下单、不调模型。
`);
}

export class WatchlistCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof WatchlistCliError ||
      error instanceof ConfigLoadError ||
      error instanceof StorageError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
