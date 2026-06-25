import { pathToFileURL } from "node:url";
import path from "node:path";
import { ConfigLoadError, loadConfig } from "../../src/config/index.js";
import {
  assertPaperOnly,
  buildFunnelExecutionConstraints,
  buildWatchlistFromScreen,
  executePendingOrder,
  maintainDailyFunnel,
} from "../../src/app/index.js";
import { snapshotWatchlist } from "../../src/domain/plan/index.js";
import { toBeijingDateTime } from "../../src/infrastructure/scheduler/index.js";
import {
  CachingUniverseProvider,
  EastmoneyUniverseProvider,
  FallbackUniverseProvider,
  FileUniverseCacheStore,
  MockBrainProvider,
  SinaUniverseProvider,
  TencentQuoteProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  PlanMemoryStore,
  ProposalMemoryStore,
  WatchlistMemoryStore,
} from "../../src/infrastructure/storage/index.js";
import { readBridgeAccountAndPositions } from "./build-context.js";
import { buildDaemonNotifiers } from "./push-notifiers.js";

interface FunnelCli {
  alarm: string;
  autoPaper: boolean;
  dryRun: boolean;
  memoryDir?: string;
}

/**
 * Daily selection funnel for ONE node: refresh the 100 高关注池 (deterministic screen) →
 * model-select 10 潜力股 + 待买/待卖 (proposals, executable:false) → persist plan + proposals →
 * push to Feishu. Default is propose-only (human confirms in Feishu). `--auto-paper` lets the
 * PAPER simulation auto-fill — hard-gated to paper-only (refuses on any live/non-paper config),
 * NEVER real money. The model never executes; it only proposes.
 *
 * Usage: npm run funnel:dev -- --alarm pre_market_plan [--auto-paper] [--dry-run]
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const cli = parseArgs(process.argv.slice(2));
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const tradingDate = toBeijingDateTime(new Date()).date;
  const asOf = new Date().toISOString();

  const { account, positions } = readBridgeAccountAndPositions(memoryDir);
  if (!account) {
    console.error("未找到模拟盘账户，请先建账户。");
    return;
  }

  if (cli.autoPaper) {
    // Hard paper-only gate ONCE up front (executePendingOrder re-checks defensively per order).
    try {
      assertPaperOnly(config, account);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    console.log("⚠️ --auto-paper：模拟盘自动成交已开启（仅限 paper 账户，永不触实盘）。");
  }

  // Stage A — refresh the 100 高关注池 (deterministic screen; cache → Eastmoney → Sina → stale).
  const universeProvider = new CachingUniverseProvider({
    inner: new FallbackUniverseProvider([
      new EastmoneyUniverseProvider(),
      new SinaUniverseProvider(),
    ]),
    store: new FileUniverseCacheStore(path.join(memoryDir, "market", "cache")),
  });
  const screen = await buildWatchlistFromScreen({
    provider: universeProvider,
    writer: new WatchlistMemoryStore({ memoryDir }),
    category: "watchlist_today",
    criteria: { limit: 100, sortBy: "amount", minAmount: 1e8 },
  });
  const watchlist100 = snapshotWatchlist(screen.entries);
  const quoteTargets = new Map<string, { symbol: string; market: "SSE" | "SZSE"; name: string }>();
  for (const entry of watchlist100) {
    quoteTargets.set(entry.symbol, { symbol: entry.symbol, market: entry.market, name: entry.name });
  }
  for (const position of positions) {
    quoteTargets.set(position.symbol, {
      symbol: position.symbol,
      market: position.market,
      name: position.name,
    });
  }
  const quoteProvider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const quotes = await quoteProvider.getQuotes([...quoteTargets.values()]).catch(() => []);
  const priceBySymbol = new Map(quotes.map((quote) => [quote.symbol, quote.latestPrice]));
  const prices = Object.fromEntries(priceBySymbol);
  const executionConstraints = buildFunnelExecutionConstraints({
    account,
    positions,
    watchlist100,
    prices,
    config,
    maxBuyOrders: 2,
    maxSellOrders: 2,
  });
  console.log(`🪣 100 高关注池已刷新：${watchlist100.length} 支（来源 ${screen.mode}）。`);

  // Stage B+C — model select + persist + push (proposal-only).
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const notifiers = await buildDaemonNotifiers(config);
  const { plan, proposals, degraded } = await maintainDailyFunnel(
    {
      alarmType: cli.alarm,
      tradingDate,
      asOf,
      accountId: account.accountId,
      watchlist100,
      holdings: positions.map((position) => ({
        symbol: position.symbol,
        market: position.market,
        name: position.name,
      })),
      autoPaper: cli.autoPaper,
      executionConstraints,
    },
    {
      brainProvider,
      planStore: new PlanMemoryStore({ memoryDir }),
      proposalStore: new ProposalMemoryStore({ memoryDir }),
      notifiers,
    },
  );

  console.log(
    `🧠 ${cli.alarm}：潜力股 ${plan.shortlist10.length} 支｜待买卖 ${proposals.length} 笔${degraded ? "（模型降级，取 top-N）" : ""}。`,
  );
  for (const order of proposals) {
    const sized =
      order.quantity !== undefined && order.limitPrice !== undefined ? ` ${order.quantity}股@${order.limitPrice}` : "";
    console.log(`  ${order.side} ${order.symbol} ${order.name ?? ""}${sized}：${order.rationale}`);
  }
  console.log(`计划已落库：${memoryDir}/plans/${tradingDate}/；提案：${memoryDir}/proposals/。`);

  // Execution — default propose-only; --auto-paper fills via the hard-gated paper path.
  if (proposals.length === 0) {
    return;
  }
  if (!cli.autoPaper || cli.dryRun) {
    console.log(
      "（未开启 --auto-paper 或处于 dry-run，本次只落库执行计划，不写入模拟成交。）",
    );
    return;
  }

  console.log("🤖 模拟盘自动成交（仅 paper）：");
  for (const proposal of proposals) {
    const price = proposal.limitPrice ?? priceBySymbol.get(proposal.symbol);
    if (price === undefined) {
      console.log(`  ${proposal.symbol}：跳过（无报价）`);
      continue;
    }
    const result = executePendingOrder(
      { proposal, latestPrice: price, reviewer: "auto-paper" },
      { config, memoryDir },
    );
    console.log(
      `  ${proposal.side} ${proposal.symbol}：${result.status}${result.reason ? `（${result.reason}）` : ""}${
        result.quantity ? ` ${result.quantity}股@${result.limitPrice}` : ""
      }`,
    );
  }
}

function parseArgs(argv: string[]): FunnelCli {
  const result: FunnelCli = { alarm: "funnel_maintenance", autoPaper: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--alarm") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new FunnelCliError("--alarm 需要一个节点名");
      }
      result.alarm = value;
      i += 1;
    } else if (arg === "--memory-dir") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new FunnelCliError("--memory-dir 需要一个路径");
      }
      result.memoryDir = value;
      i += 1;
    } else if (arg === "--auto-paper") {
      result.autoPaper = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
    } else {
      throw new FunnelCliError(`未知参数：${arg}`);
    }
  }
  return result;
}

class FunnelCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelCliError";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof FunnelCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
