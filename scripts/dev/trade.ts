import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import { normalizeStockSymbol } from "../../src/domain/market/index.js";
import {
  calculatePortfolioValuation,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import { RiskEngine } from "../../src/domain/risk/index.js";
import {
  createOrderFromIntent,
  tradeIntentSchema,
  type TradeIntent,
} from "../../src/domain/trading/index.js";
import { PaperBroker } from "../../src/infrastructure/broker/index.js";

interface TradeCliOptions {
  help: boolean;
  side: "BUY" | "SELL";
  symbol: string;
  quantity: number;
  price: number;
  name?: string;
  memoryDir?: string;
}

/**
 * Places a paper order against the local simulation DB.
 *
 * Flow: build a trade intent -> RiskEngine pre-check (single-position cap, stop
 * loss, daily loss) for buys -> PaperBroker (main-board / 100-lot / cash / T+1
 * via PolicyEngine) executes and persists account/positions/trades. Fully local
 * and offline; never touches a real broker.
 */
export async function main(argv: string[]): Promise<void> {
  const cli = parseArgs(argv);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const broker = new PaperBroker({ memoryDir, t1Enabled: config.trading.t1Enabled });
  const account = broker.getAccount();
  const positions = broker.getPositions();
  const symbol = normalizeStockSymbol(cli.symbol);
  const now = new Date();

  const intent: TradeIntent = tradeIntentSchema.parse({
    intentId: `intent-${cli.side.toLowerCase()}-${symbol.symbol}-${now.getTime()}`,
    accountId: account.accountId,
    symbol: symbol.symbol,
    market: symbol.market,
    name: cli.name ?? symbol.name,
    side: cli.side,
    quantity: cli.quantity,
    limitPrice: cli.price,
    currency: "CNY",
    source: "user",
    createdAt: now.toISOString(),
  });

  if (cli.side === "BUY") {
    const risk = runRiskPrecheck(account, positions, intent, config, now);

    if (risk === "blocked") {
      process.exit(1);
      return;
    }
  }

  const result = broker.submitOrder(intent);

  if (result.idempotent) {
    console.log("（该 intent 已执行过，幂等返回，未重复下单。）");
  }

  if (result.order.status === "rejected") {
    console.log(`❌ 下单被拒：${result.order.rejectReason?.code} - ${result.order.rejectReason?.message}`);
    process.exit(1);
    return;
  }

  const trade = result.trade;
  console.log(
    `✅ 成交：${cli.side === "BUY" ? "买入" : "卖出"} ${symbol.market}:${symbol.symbol} ${cli.quantity}股 @ ${cli.price}` +
      (trade ? `，金额 ${trade.netAmount}（费 ${trade.fees} 税 ${trade.tax}）` : ""),
  );

  printSnapshot(result.account ?? account, result.positions ?? positions, cli.price, symbol.symbol);
}

function runRiskPrecheck(
  account: Account,
  positions: Position[],
  intent: TradeIntent,
  config: ReturnType<typeof loadConfig>,
  now: Date,
): "ok" | "blocked" {
  const order = createOrderFromIntent({
    orderId: `order-precheck-${now.getTime()}`,
    intent,
    now,
  });
  const risk = new RiskEngine().check({
    account,
    positions,
    order,
    options: {
      maxSinglePositionRatio: config.risk.maxSinglePositionRatio,
      hardStopLossRatio: config.risk.hardStopLossRatio,
      dailyLossLimitRatio: config.risk.dailyLossLimitRatio,
      prices: { [intent.symbol]: intent.limitPrice },
    },
  });

  if (risk.decision === "rejected") {
    console.log("❌ 风控拦截（RiskEngine），不予下单：");
    for (const violation of risk.blockingViolations) {
      console.log(`  - [${violation.code}] ${violation.message}`);
    }
    return "blocked";
  }

  for (const violation of risk.violations) {
    console.log(`⚠️ 风控提示 [${violation.code}]：${violation.message}`);
  }

  return "ok";
}

function printSnapshot(
  account: Account,
  positions: Position[],
  price: number,
  symbol: string,
): void {
  const valuation = calculatePortfolioValuation(account, positions, {
    prices: { [symbol]: price },
  });

  console.log("—— 模拟盘 DB 最新状态 ——");
  console.log(`可用现金：${valuation.cash.available}　总资产：${valuation.totalAssets}　仓位：${(valuation.investedRatio * 100).toFixed(2)}%`);

  if (valuation.positions.length === 0) {
    console.log("持仓：无");
    return;
  }

  for (const position of valuation.positions) {
    console.log(
      `  ${position.market}:${position.symbol} ${position.name}　${position.quantity}股（可卖${position.sellableQuantity}）　成本${position.costPrice}　现价${position.latestPrice}　浮盈亏${position.unrealizedPnl}（仓位${(position.positionRatio * 100).toFixed(2)}%）`,
    );
  }
}

function parseArgs(argv: string[]): TradeCliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true, side: "BUY", symbol: "", quantity: 0, price: 0 };
  }

  const positional: string[] = [];
  const options: Partial<TradeCliOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--name") {
      options.name = argv[index + 1];
      index += 1;
    } else if (arg === "--memory-dir") {
      options.memoryDir = argv[index + 1];
      index += 1;
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  const [sideRaw, symbolRaw, quantityRaw, priceRaw] = positional;
  const side = sideRaw?.toUpperCase();

  if (side !== "BUY" && side !== "SELL") {
    throw new TradeCliError(`side must be buy or sell (got: ${sideRaw ?? "missing"})`);
  }

  if (!symbolRaw || !/^\d{6}$/.test(symbolRaw)) {
    throw new TradeCliError(`symbol must be a 6-digit A-share code (got: ${symbolRaw ?? "missing"})`);
  }

  const quantity = Number(quantityRaw);
  const price = Number(priceRaw);

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new TradeCliError(`quantity must be a positive integer (got: ${quantityRaw ?? "missing"})`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new TradeCliError(`price must be a positive number (got: ${priceRaw ?? "missing"})`);
  }

  return {
    help: false,
    side,
    symbol: symbolRaw,
    quantity,
    price,
    name: options.name,
    memoryDir: options.memoryDir,
  };
}

function printHelp(): void {
  console.log(`trade - 在模拟盘 DB 下单（买/卖）

用法:
  npm run trade -- buy 000636 100 12.50
  npm run trade -- sell 000636 100 13.00 --name 风华高科

说明:
  走 RiskEngine（单股40%/止损/单日亏损）+ PaperBroker（主板/100股/现金/T+1）后端风控，
  成交后写入 memory/portfolio（account/positions/trades）并打印最新 DB 状态。
  纯本地模拟，不接真实券商、不联网。下单后可用 npm run ask 让模型点评持仓。
`);
}

export class TradeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TradeCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof TradeCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
