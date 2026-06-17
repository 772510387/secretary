import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  MarketSentinelDaemonError,
  createMarketSentinelDaemon,
} from "../../src/runtime/index.js";
import type {
  Clock,
  SchedulerTask,
  TradingSessionOptions,
} from "../../src/infrastructure/scheduler/index.js";
import { WeComBotNotifier } from "../../src/infrastructure/notification/index.js";
import {
  notificationEventSchema,
  type NotificationSeverity,
} from "../../src/domain/notification/index.js";
import { z } from "zod";
import {
  cerebellumEventToNotificationEvent,
  createLivePaperSentinelTask,
} from "../../src/app/index.js";
import { positionSchema, type Position } from "../../src/domain/portfolio/index.js";
import type { NotificationEvent } from "../../src/domain/notification/index.js";
import type {
  WatchlistCategory,
  WatchlistEntry,
} from "../../src/domain/market/index.js";
import {
  TencentIndexProvider,
  TencentQuoteProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  JsonStore,
  WatchlistMemoryStore,
  createPortfolioMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import { formatNotificationForConsole } from "../../src/domain/notification/index.js";

const positionsSchema = z.array(positionSchema);

export type MarketSentinelDaemonCliOptions =
  | {
    help: true;
  }
  | {
    help: false;
    jobId?: string;
    intervalMs?: number;
    outsideSessionIntervalMs?: number;
    runMs?: number;
    memoryDir?: string;
    at?: string;
    allowOutsideSession: boolean;
    live: boolean;
  };

interface PartialMarketSentinelDaemonCliOptions {
  help: boolean;
  jobId?: string;
  intervalMs?: number;
  outsideSessionIntervalMs?: number;
  runMs?: number;
  memoryDir?: string;
  at?: string;
  allowOutsideSession: boolean;
  live: boolean;
}

export async function main(args: string[]): Promise<void> {
  const cli = parseMarketSentinelDaemonArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const wecomNotifier = buildWecomNotifier(config);
  const reporter = createWeComReporter(wecomNotifier, config);
  const clock = cli.at ? fixedClock(cli.at) : undefined;
  const tradingSession = cli.allowOutsideSession ? alwaysOpenTradingSession() : undefined;
  const task = cli.live ? buildLivePaperSentinelTask(memoryDir, wecomNotifier, config) : undefined;
  const daemon = createMarketSentinelDaemon({
    memoryDir,
    jobId: cli.jobId,
    intervalMs: cli.intervalMs ?? config.market.sentinelIntervalMs,
    outsideSessionIntervalMs: cli.outsideSessionIntervalMs,
    clock,
    tradingSession,
    task,
  });
  const start = daemon.start();
  await reporter?.started();

  if (cli.runMs !== undefined) {
    await delay(cli.runMs);
    const stop = await daemon.stop("run-ms-elapsed");
    await reporter?.stopped(stop.status);

    console.log(
      JSON.stringify(
        {
          status: "ok",
          mode: "market-sentinel-daemon",
          start,
          stop,
          liveTrading: false,
          brainProvider: "mock",
          brokerConnected: false,
          networkAllowed: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    JSON.stringify(
      {
        status: "running",
        mode: "market-sentinel-daemon",
        start,
        liveTrading: false,
        brainProvider: "mock",
        brokerConnected: false,
        networkAllowed: cli.live,
        marketWatch: cli.live ? "live" : "mock",
      },
      null,
      2,
    ),
  );

  const heartbeat = reporter?.startHeartbeat();
  const reason = await waitForShutdownSignal();
  heartbeat?.stop();
  const stop = await daemon.stop(reason);
  await reporter?.stopped(stop.status);

  console.log(
    JSON.stringify(
      {
        status: "stopped",
        mode: "market-sentinel-daemon",
        stop,
      },
      null,
      2,
    ),
  );
}

interface WeComReporter {
  started(): Promise<void>;
  stopped(status: string): Promise<void>;
  startHeartbeat(): { stop(): void } | undefined;
}

/**
 * Pushes daemon lifecycle/heartbeat status to a WeCom group bot.
 *
 * Enabled only when WECOM_BOT_WEBHOOK_URL is configured AND WECOM_NOTIFY=1 is set
 * (explicit opt-in, consistent with the project's "no network unless enabled"
 * boundary). Both come from config/.env so it works the same locally and in Docker.
 * Notification failures are swallowed so they can never crash the daemon.
 * This is one-way status push, not a command channel.
 */
function buildWecomNotifier(config: ReturnType<typeof loadConfig>): WeComBotNotifier | null {
  const url = config.notification.wecomBotWebhookUrl;

  if (!url || !config.notification.wecomNotify) {
    return null;
  }

  return new WeComBotNotifier({
    webhookUrl: url,
    severityAllowlist: ["info", "watch", "warning", "critical"],
  });
}

function createWeComReporter(
  notifier: WeComBotNotifier | null,
  config: ReturnType<typeof loadConfig>,
): WeComReporter | null {
  if (!notifier) {
    return null;
  }

  const send = async (
    severity: NotificationSeverity,
    summary: string,
    action: string,
  ): Promise<void> => {
    try {
      const event = notificationEventSchema.parse({
        eventId: `daemon-${severity}-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        severity,
        source: { type: "scheduler", id: "market-sentinel-daemon" },
        target: { type: "system" },
        summary,
        recommendedAction: action,
        channels: ["wechat"],
      });
      await notifier.notify(event);
    } catch {
      // A notification problem must never take down the daemon.
    }
  };

  return {
    started: () =>
      send("info", "Secretary 哨兵 daemon 已启动并开始值守。", "收到即代表后台在运行，无需操作。"),
    stopped: (status) =>
      send("info", `Secretary 哨兵 daemon 已停止（${status}）。`, "无需操作。"),
    startHeartbeat: () => {
      const ms = config.notification.wecomHeartbeatMs;

      if (ms === undefined || ms < 60_000) {
        // Off by default; opt in with WECOM_HEARTBEAT_MS >= 60000 to avoid spam.
        return undefined;
      }

      const startedAt = Date.now();
      const timer = setInterval(() => {
        const minutes = Math.round((Date.now() - startedAt) / 60_000);
        void send("info", `哨兵 daemon 心跳正常，已运行约 ${minutes} 分钟。`, "无需操作。");
      }, ms);
      timer.unref?.();

      return { stop: () => clearInterval(timer) };
    },
  };
}

export function parseMarketSentinelDaemonArgs(args: string[]): MarketSentinelDaemonCliOptions {
  const options: PartialMarketSentinelDaemonCliOptions = {
    help: false,
    allowOutsideSession: false,
    live: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--job-id":
        options.jobId = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--interval-ms":
        options.intervalMs = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--outside-session-interval-ms":
        options.outsideSessionIntervalMs = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--run-ms":
        options.runMs = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--memory-dir":
        options.memoryDir = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--at":
        options.at = parseDateTime(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--allow-outside-session":
        options.allowOutsideSession = true;
        break;
      case "--live":
        options.live = true;
        break;
      default:
        throw new MarketSentinelDaemonCliError(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return { help: true };
  }

  return {
    help: false,
    jobId: options.jobId,
    intervalMs: options.intervalMs,
    outsideSessionIntervalMs: options.outsideSessionIntervalMs,
    runMs: options.runMs,
    memoryDir: options.memoryDir,
    at: options.at,
    allowOutsideSession: options.allowOutsideSession,
    live: options.live,
  };
}

export class MarketSentinelDaemonCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSentinelDaemonCliError";
  }
}

function readValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new MarketSentinelDaemonCliError(`Missing value for ${name}`);
  }

  return value;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MarketSentinelDaemonCliError(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseDateTime(value: string, name: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new MarketSentinelDaemonCliError(`${name} must be a valid date or datetime`);
  }

  return parsed.toISOString();
}

function parseNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new MarketSentinelDaemonCliError(`${name} must not be empty`);
  }

  return trimmed;
}

/**
 * Builds the live market-watch task for the daemon: each tick it reads the paper
 * positions, fetches real Tencent quotes, runs the deterministic MarketSentinel,
 * marks positions to market in the DB, logs any anomaly, and pushes warning/
 * critical events to WeCom (when configured). Transient quote failures are
 * swallowed so one bad tick never crashes the daemon.
 */
function buildLivePaperSentinelTask(
  memoryDir: string,
  wecomNotifier: WeComBotNotifier | null,
  config: ReturnType<typeof loadConfig>,
): SchedulerTask {
  const quoteProvider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const indexProvider = new TencentIndexProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const watchlistStore = new WatchlistMemoryStore({ memoryDir });
  const pushNotification = async (notification: NotificationEvent): Promise<void> => {
    console.log(formatNotificationForConsole(notification));

    if (wecomNotifier) {
      try {
        await wecomNotifier.notify(notification);
      } catch {
        // A notification problem must never take down the daemon.
      }
    }
  };
  const innerTask = createLivePaperSentinelTask({
    getPositions: () => readPositionsSafe(memoryDir),
    getWatchlistEntries: () => readWatchlistEntriesSafe(watchlistStore),
    getQuotes: (symbols) => quoteProvider.getQuotes(symbols),
    persistPositions: (positions) => writePositions(memoryDir, positions),
    options: { positionStopLossRatio: config.risk.hardStopLossRatio },
    getIndexSnapshots: () => indexProvider.getIndexes(),
    onEvents: async (events) => {
      for (const event of events) {
        await pushNotification(cerebellumEventToNotificationEvent(event));
      }
    },
    onIndexNotifications: async (notifications) => {
      for (const notification of notifications) {
        await pushNotification(notification);
      }
    },
  });

  return async () => {
    try {
      await innerTask();
    } catch (error) {
      console.error(`(盯市本轮失败，已跳过：${error instanceof Error ? error.message : String(error)})`);
    }
  };
}

function readPositionsSafe(memoryDir: string): Position[] {
  const positionsPath = createPortfolioMemoryPaths(memoryDir).positionsPath;

  if (!existsSync(positionsPath)) {
    return [];
  }

  try {
    return positionsSchema.parse(JSON.parse(readFileSync(positionsPath, "utf8")));
  } catch {
    return [];
  }
}

function writePositions(memoryDir: string, positions: Position[]): void {
  const positionsPath = createPortfolioMemoryPaths(memoryDir).positionsPath;
  new JsonStore<Position[]>({ filePath: positionsPath, schema: positionsSchema }).write(positions);
}

const WATCHLIST_CATEGORIES: readonly WatchlistCategory[] = [
  "watchlist_today",
  "watchlist_long_term",
  "potential_stocks",
];

function readWatchlistEntriesSafe(store: WatchlistMemoryStore): WatchlistEntry[] {
  try {
    return WATCHLIST_CATEGORIES.flatMap((category) => store.readCategory(category).entries);
  } catch {
    return [];
  }
}

function fixedClock(iso: string): Clock {
  return {
    now: () => new Date(iso),
  };
}

function alwaysOpenTradingSession(): TradingSessionOptions {
  return {
    weekdayOnly: false,
    sessions: [{ start: "00:00", end: "23:59" }],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = (): void => {
      cleanup();
      resolve("SIGINT");
    };
    const onSigterm = (): void => {
      cleanup();
      resolve("SIGTERM");
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

function printHelp(): void {
  console.log(`market-sentinel-daemon

Usage:
  npm run sentinel:dev -- --run-ms 1000 --allow-outside-session

Options:
  --job-id <id>                         Optional scheduler job id.
  --interval-ms <ms>                    Optional in-session interval. Defaults to config market.sentinelIntervalMs.
  --outside-session-interval-ms <ms>    Optional outside-session interval.
  --run-ms <ms>                         Optional auto-stop duration for local smoke tests.
  --memory-dir <path>                   Optional memory root. Defaults to configured storage.memoryDir.
  --at <datetime>                       Optional fixed scheduler/audit time.
  --allow-outside-session               Treat the whole day as open for local smoke tests.
  --live                                 Watch real paper positions against live Tencent quotes
                                         (mark-to-market + anomaly alerts). Pushes warning/critical
                                         events to WeCom when WECOM_NOTIFY=1 and a webhook are set.

Without --live the daemon uses a mock sentinel task and never touches the network. With --live it
reads memory/portfolio positions, fetches real quotes, marks them to market, and alerts on rapid
moves / cost stop-loss. It never calls the brain, never trades, and never connects to a real broker.
Recommended live interval: --interval-ms 30000 (avoid hammering the quote API).
`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof MarketSentinelDaemonCliError ||
      error instanceof MarketSentinelDaemonError ||
      error instanceof ConfigLoadError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
