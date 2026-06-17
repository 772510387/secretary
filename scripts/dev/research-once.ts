import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  RunResearchOnceError,
  runResearchOnce,
} from "../../src/app/index.js";
import { ResearchValidationError } from "../../src/domain/research/index.js";
import {
  ResearchMemoryStore,
  StorageError,
} from "../../src/infrastructure/storage/index.js";

type ResearchOnceMarket = "SSE" | "SZSE";

export type ResearchOnceCliOptions =
  | {
    help: true;
  }
  | {
    help: false;
    symbol: string;
    market: ResearchOnceMarket;
    date: string;
    objective: string;
    name?: string;
    taskId?: string;
    at?: string;
    memoryDir?: string;
  };

interface PartialResearchOnceCliOptions {
  help: boolean;
  symbol?: string;
  market?: ResearchOnceMarket;
  date?: string;
  objective?: string;
  name?: string;
  taskId?: string;
  at?: string;
  memoryDir?: string;
}

export async function main(args: string[]): Promise<void> {
  const cli = parseResearchOnceArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const runAt = cli.at ?? new Date().toISOString();
  const writer = new ResearchMemoryStore({
    memoryDir: cli.memoryDir ?? config.storage.memoryDir,
    now: () => new Date(runAt),
  });
  const result = await runResearchOnce({
    symbol: cli.symbol,
    market: cli.market,
    name: cli.name,
    tradingDate: cli.date,
    objective: cli.objective,
    taskId: cli.taskId,
    now: runAt,
    createdAt: runAt,
    writer,
    writeToMemory: true,
    metadata: {
      source: "research-once-script",
      script: "scripts/dev/research-once.ts",
    },
  });

  console.log(
    JSON.stringify(
      {
        status: "ok",
        mode: result.mode,
        provider: result.report.provider,
        reportId: result.report.reportId,
        taskId: result.task.taskId,
        symbol: result.report.symbol,
        market: result.report.market,
        tradingDate: result.report.tradingDate,
        degraded: result.report.degraded,
        reportPath: result.write?.filePath,
        backupPath: result.write?.backupPath,
        auditLogPath: result.write?.auditLogPath,
        auditBackupPath: result.write?.auditBackupPath,
        liveTrading: false,
        brokerConnected: false,
      },
      null,
      2,
    ),
  );
}

export function parseResearchOnceArgs(args: string[]): ResearchOnceCliOptions {
  const options: PartialResearchOnceCliOptions = {
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--symbol":
        options.symbol = parseSymbol(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--market":
        options.market = parseMarket(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--date":
      case "--trading-date":
        options.date = parseTradeDate(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--objective":
        options.objective = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--name":
        options.name = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--task-id":
        options.taskId = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--at":
        options.at = parseDateTime(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--memory-dir":
        options.memoryDir = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new ResearchOnceCliError(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return {
      help: true,
    };
  }

  const missing = [
    ["--symbol", options.symbol],
    ["--market", options.market],
    ["--date", options.date],
    ["--objective", options.objective],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new ResearchOnceCliError(`Missing required argument(s): ${missing.join(", ")}`);
  }

  return {
    help: false,
    symbol: options.symbol!,
    market: options.market!,
    date: options.date!,
    objective: options.objective!,
    name: options.name,
    taskId: options.taskId,
    at: options.at,
    memoryDir: options.memoryDir,
  };
}

function readValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new ResearchOnceCliError(`Missing value for ${name}`);
  }

  return value;
}

function parseSymbol(value: string, name: string): string {
  if (!/^\d{6}$/.test(value)) {
    throw new ResearchOnceCliError(`${name} must be a 6-digit A-share symbol`);
  }

  return value;
}

function parseMarket(value: string, name: string): ResearchOnceMarket {
  if (value !== "SSE" && value !== "SZSE") {
    throw new ResearchOnceCliError(`${name} must be SSE or SZSE`);
  }

  return value;
}

function parseTradeDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ResearchOnceCliError(`${name} must use YYYY-MM-DD`);
  }

  return value;
}

function parseDateTime(value: string, name: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ResearchOnceCliError(`${name} must be a valid date or datetime`);
  }

  return parsed.toISOString();
}

function parseNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new ResearchOnceCliError(`${name} must not be empty`);
  }

  return trimmed;
}

function printHelp(): void {
  console.log(`research-once

Usage:
  npm run research:once -- --symbol 000636 --market SZSE --date 2026-06-13 --objective "Generate one safe research report"

Options:
  --symbol <code>        Required. 6-digit A-share symbol.
  --market <SSE|SZSE>    Required. Stock market.
  --date <YYYY-MM-DD>    Required. Trading date.
  --objective <text>     Required. Research objective.
  --name <text>          Optional stock display name.
  --task-id <id>         Optional task id. Defaults to research-task-{symbol}-{date}.
  --at <datetime>        Optional fixed generation/audit timestamp.
  --memory-dir <path>    Optional memory root. Defaults to configured storage.memoryDir.

This development script uses the local mock runner only. It writes memory/research and audit metadata, but never connects to TradingAgents-CN or broker adapters.
`);
}

export class ResearchOnceCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchOnceCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof ResearchOnceCliError
      || error instanceof ConfigLoadError
      || error instanceof RunResearchOnceError
      || error instanceof ResearchValidationError
      || error instanceof StorageError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
