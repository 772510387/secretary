import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  DailyBudget,
  MarketSentinelDaemonError,
  createMarketSentinelDaemon,
} from "../../src/runtime/index.js";
import type {
  Clock,
  SchedulerTask,
  TradingSessionOptions,
} from "../../src/infrastructure/scheduler/index.js";
import type { ExternalNotificationNotifier } from "../../src/infrastructure/notification/index.js";
import {
  notificationEventSchema,
  shouldPushToExternalChannels,
  type NotificationSeverity,
} from "../../src/domain/notification/index.js";
import { buildDaemonNotifiers } from "./push-notifiers.js";
import { z } from "zod";
import {
  analyzeMarketAlert,
  cerebellumEventToNotificationEvent,
  createLivePaperSentinelTask,
  enrichSentinelNotification,
  executePaperStopLoss,
  type ExecutePendingOrderResult,
} from "../../src/app/index.js";
import type { CerebellumEvent } from "../../src/domain/cerebellum/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import type { BrainProvider } from "../../src/domain/brain/index.js";
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
  AlertStateStore,
  JsonStore,
  WatchlistMemoryStore,
  createPortfolioMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import { formatNotificationForConsole } from "../../src/domain/notification/index.js";
import {
  DEFAULT_SILENT_PATROL_SESSIONS,
  checkMarketSentinel,
  toCerebellumBeijingTime,
} from "../../src/domain/cerebellum/index.js";

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
    wakeBrain: boolean;
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
  wakeBrain: boolean;
}

export async function main(args: string[]): Promise<void> {
  const cli = parseMarketSentinelDaemonArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const notifiers = await buildDaemonNotifiers(config);
  const reporter = createDaemonReporter(notifiers);
  const clock = cli.at ? fixedClock(cli.at) : undefined;
  const tradingSession = cli.allowOutsideSession ? alwaysOpenTradingSession() : undefined;
  // The brain is woken only on redline events (cooldown-bounded), so idle stays free.
  const brainProvider = cli.wakeBrain
    ? config.brain.provider === "mock"
      ? new MockBrainProvider()
      : createBrainProvider(config.brain)
    : undefined;

  if (cli.wakeBrain) {
    console.log(
      brainProvider && config.brain.provider !== "mock"
        ? `异动唤醒大脑：开启（${config.brain.provider}），仅 wakeBrain 事件触发 AI 研判。`
        : "异动唤醒大脑：开启（mock，仅占位，不产生真实研判）。",
    );
  }

  const budget = new DailyBudget({
    brain: config.budget.brainDailyLimit,
    research: config.budget.researchDailyLimit,
    search: config.budget.searchDailyLimit,
  });
  const task = cli.live
    ? buildLivePaperSentinelTask(memoryDir, notifiers, config, brainProvider, budget)
    : undefined;
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

  const reason = await waitForShutdownSignal();
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

interface DaemonReporter {
  started(): Promise<void>;
  stopped(status: string): Promise<void>;
}

/**
 * Pushes daemon lifecycle status (started/stopped) to the configured external
 * notifiers (Feishu, when FEISHU_NOTIFY=1). Null when no notifier is configured.
 * Notification failures are swallowed so they can never crash the daemon.
 * This is one-way status push, not a command channel.
 */
function createDaemonReporter(
  notifiers: ExternalNotificationNotifier[],
): DaemonReporter | null {
  if (notifiers.length === 0) {
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
        channels: ["console"],
      });
      for (const notifier of notifiers) {
        await notifier.notify(event);
      }
    } catch {
      // A notification problem must never take down the daemon.
    }
  };

  return {
    started: () =>
      send("info", "Secretary 哨兵 daemon 已启动并开始值守。", "收到即代表后台在运行，无需操作。"),
    stopped: (status) =>
      send("info", `Secretary 哨兵 daemon 已停止（${status}）。`, "无需操作。"),
  };
}

export function parseMarketSentinelDaemonArgs(args: string[]): MarketSentinelDaemonCliOptions {
  const options: PartialMarketSentinelDaemonCliOptions = {
    help: false,
    allowOutsideSession: false,
    live: false,
    wakeBrain: false,
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
      case "--wake-brain":
        options.wakeBrain = true;
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
    wakeBrain: options.wakeBrain,
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
 * critical events to the configured external channel (Feishu, when enabled).
 * Transient quote failures are swallowed so one bad tick never crashes the daemon.
 */
export function buildLivePaperSentinelTask(
  memoryDir: string,
  notifiers: ExternalNotificationNotifier[],
  config: ReturnType<typeof loadConfig>,
  brainProvider?: BrainProvider,
  budget?: DailyBudget,
): SchedulerTask {
  const quoteProvider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const indexProvider = new TencentIndexProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const watchlistStore = new WatchlistMemoryStore({ memoryDir });
  const alertStore = new AlertStateStore({ memoryDir });
  const pushNotification = async (notification: NotificationEvent): Promise<void> => {
    console.log(formatNotificationForConsole(notification));

    // Operator push gate: 3s sentinel / volume-price / non-critical index observations
    // stay in the local log; only executed operations + hard red-lines go external.
    if (!shouldPushToExternalChannels(notification)) {
      return;
    }

    for (const notifier of notifiers) {
      try {
        const result = await notifier.notify(notification);
        if (result.status === "failed") {
          console.error(`[推送失败] ${notifier.channel}：${result.error ?? "未知错误"}`);
        }
      } catch (error) {
        // A notification problem must never take down the daemon — but surface it.
        console.error(
          `[推送异常] ${notifier.channel}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
  const innerTask = createLivePaperSentinelTask({
    getPositions: () => readPositionsSafe(memoryDir),
    getWatchlistEntries: () => readWatchlistEntriesSafe(watchlistStore),
    getQuotes: (symbols) => quoteProvider.getQuotes(symbols),
    persistPositions: (positions) => writePositions(memoryDir, positions),
    // Cooldown survives restarts + is shared with the 10-min patrol via alert_state.json.
    initialCooldownState: alertStore.readCooldownState(),
    onCooldownState: (state) => alertStore.writeCooldownState(state),
    // ±5% 绝对涨跌幅红线 + 8% 硬止损（opt-in here; the pure detector defaults off).
    options: { positionStopLossRatio: config.risk.hardStopLossRatio, absoluteMoveThreshold: 0.05 },
    volumeOptions: { volumeSurgeRatio: 2, baselineWindow: 20 },
    getIndexSnapshots: () => indexProvider.getIndexes(),
    onEvents: async (events) => {
      for (const event of events) {
        const base = cerebellumEventToNotificationEvent(event);

        // 8% 硬止损：在模拟盘里无条件强制平仓（确定性，不询问大脑）。仅 paper；实盘/非 paper 配置会被
        // executePaperStopLoss 的硬闸拒绝（抛错 → 这里吞掉，只推确定性告警）。
        if (event.eventType === "position_stop_loss") {
          try {
            const result = executePaperStopLoss(
              {
                symbol: event.symbol,
                market: event.market,
                name: event.name,
                latestPrice: event.currentPrice,
                reason: `8% 硬止损强制平仓（现价 ${event.currentPrice}）`,
              },
              { config, memoryDir },
            );
            if (result.status === "filled" && !result.idempotent) {
              await pushNotification(stopLossCloseReport(event, result));
              continue; // close report supersedes the plain "请人工评估" alert
            }
          } catch {
            // live/non-paper config → never auto-close; fall through to the deterministic alert.
          }
        }

        // Eye -> brain: only redline (wakeBrain) events spend a model call to add
        // an AI judgement; everything else pushes the cheap deterministic alert.
        // The per-day budget bounds a volatile day's anomaly storm.
        if (brainProvider && event.wakeBrain && (!budget || budget.tryConsume("brain"))) {
          try {
            const position = readPositionsSafe(memoryDir).find(
              (held) => held.symbol === event.symbol && held.market === event.market,
            );
            const analysis = await analyzeMarketAlert({ event, position }, { brainProvider });
            await pushNotification(enrichSentinelNotification(base, analysis));
            continue;
          } catch (error) {
            console.error(`(异动研判失败，改推确定性告警：${error instanceof Error ? error.message : String(error)})`);
          }
        }

        await pushNotification(base);
      }
    },
    onIndexNotifications: async (notifications) => {
      for (const notification of notifications) {
        await pushNotification(notification);
      }
    },
    onVolumePriceNotifications: async (notifications) => {
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

/**
 * "做完汇报" — the deterministic 8% stop-loss just force-closed a holding (paper).
 *
 * Spells out the operation AND its logic (Boss preference 2026-06-24: 触及红线→直接操作→
 * 把操作跟逻辑讲清楚): what triggered it (current vs cost, the drawdown), what was done
 * (sold N @ price, proceeds), and the realized P&L — so the push is self-explanatory.
 */
function stopLossCloseReport(event: CerebellumEvent, result: ExecutePendingOrderResult): NotificationEvent {
  const cost = event.previousPrice;
  const quantity = result.quantity ?? 0;
  const price = result.limitPrice ?? event.currentPrice;
  const drawdown =
    event.changePct !== undefined
      ? Math.abs(event.changePct)
      : cost !== undefined && cost > 0
        ? (cost - event.currentPrice) / cost
        : undefined;
  const proceeds = quantity > 0 ? quantity * price : undefined;
  const realizedPnl = cost !== undefined && quantity > 0 ? quantity * (price - cost) : undefined;

  const summary = [
    `【🛡️ 盾·8% 硬止损 | 已自动平仓（模拟盘）】`,
    `标的：${event.name}（${event.symbol}）`,
    `触发逻辑：现价 ${yuan(price)} 跌破成本 ${cost !== undefined ? yuan(cost) : "—"}，回撤 ${drawdown !== undefined ? pct(drawdown) : "—"}，触及 ≥8% 硬止损红线 → 确定性强平，不询问大脑。`,
    `执行：卖出 ${quantity} 股 @ ${yuan(price)}${proceeds !== undefined ? `，成交额 ¥${yuan(proceeds)}` : ""}。`,
    realizedPnl !== undefined ? `本笔实现盈亏（相对成本）：¥${yuan(realizedPnl)}。` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 1000);

  return notificationEventSchema.parse({
    eventId: `stoploss-exec-${event.symbol}-${Date.parse(event.occurredAt)}`.slice(0, 128),
    occurredAt: event.occurredAt,
    severity: "warning",
    source: { type: "cerebellum", id: "market-sentinel" },
    target: { type: "symbol", symbol: event.symbol, market: event.market, name: event.name },
    summary,
    recommendedAction: "确定性硬止损：跌破成本价 8% 无条件强平、不询问大脑；仅模拟盘（paper），永不触实盘/真钱。",
    channels: ["console", "file", "feishu"],
    metadata: {
      eventType: "position_stop_loss",
      autoClosed: true,
      quantity,
      price,
      costPrice: cost ?? null,
      drawdown: drawdown ?? null,
      realizedPnl: realizedPnl ?? null,
      liveTrading: false,
      brokerConnected: false,
    },
  });
}

/** Two-decimal yuan formatter for notification money fields. */
function yuan(value: number): string {
  return value.toFixed(2);
}

/** Percent formatter (0.0812 -> "8.12%") for notification ratio fields. */
function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 链式静默巡航 (chained-silence cruise): a 10-minute-cadence radar over held + watchlist names.
 *
 * Distinct from the 3-second sentinel (极速兜底). This is the 常规巡航: once per 10-minute slot
 * during sessions it compares now vs the prior slot (~10 min ago). If the max swing stays under
 * 3% it prints a silent `[PULSE]` line and spends NO model tokens; if a name swings ≥3%, breaks the
 * ±5% absolute redline, or a holding hits the 8% stop, it pushes the alert (and the 3s sentinel /
 * its brain path handle deeper analysis). Cooldown is shared with the 3s sentinel via alert_state.json,
 * so the two never double-spam the same name within the cooldown window.
 */
export function buildSilentPatrolDaemonTask(
  memoryDir: string,
  notifiers: ExternalNotificationNotifier[],
  config: ReturnType<typeof loadConfig>,
  clock?: Clock,
  brainProvider?: BrainProvider,
  budget?: DailyBudget,
): () => Promise<void> {
  const quoteProvider = new TencentQuoteProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const watchlistStore = new WatchlistMemoryStore({ memoryDir });
  const alertStore = new AlertStateStore({ memoryDir });
  let previousQuotes: Awaited<ReturnType<typeof quoteProvider.getQuotes>> = [];
  let lastSlotKey: string | undefined;

  const push = async (notification: NotificationEvent): Promise<void> => {
    console.log(formatNotificationForConsole(notification));
    // Operator push gate: the 10-minute patrol's observations stay local-only.
    if (!shouldPushToExternalChannels(notification)) {
      return;
    }
    for (const notifier of notifiers) {
      try {
        const result = await notifier.notify(notification);
        if (result.status === "failed") {
          console.error(`[推送失败] ${notifier.channel}：${result.error ?? "未知错误"}`);
        }
      } catch (error) {
        console.error(`[推送异常] ${notifier.channel}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  return async () => {
    try {
      const now = clock?.now() ?? new Date();
      const beijing = toCerebellumBeijingTime(now);

      // In a trading session + a weekday only.
      const inSession =
        beijing.dayOfWeek <= 5 &&
        DEFAULT_SILENT_PATROL_SESSIONS.some(
          (session) => beijing.minuteOfDay >= session.startMinute && beijing.minuteOfDay < session.endMinute,
        );
      if (!inSession) {
        return;
      }

      // Fire at most once per 10-minute slot (robust to tick drift — no exact-second requirement).
      const slotKey = `${beijing.date}-${Math.floor(beijing.minuteOfDay / 10)}`;
      if (slotKey === lastSlotKey) {
        return;
      }

      const positions = readPositionsSafe(memoryDir);
      const watchlistEntries = readWatchlistEntriesSafe(watchlistStore);
      const symbols = dedupePatrolSymbols(positions, watchlistEntries);
      if (symbols.length === 0) {
        lastSlotKey = slotKey;
        return;
      }

      const quotes = await quoteProvider.getQuotes(symbols);
      const cooldownState = alertStore.readCooldownState(); // pick up the 3s sentinel's recent alerts
      const result = checkMarketSentinel({
        now: now.toISOString(),
        quotes,
        positions,
        previousQuotes,
        watchlistEntries,
        cooldownState,
        options: {
          rapidMoveThreshold: 0.03, // chained-silence: <3% over the 10-min slot stays silent
          rapidMoveWindowMs: 11 * 60_000, // compare against ~10-min-ago quotes
          absoluteMoveThreshold: 0.05,
          positionStopLossRatio: config.risk.hardStopLossRatio,
        },
      });
      alertStore.writeCooldownState(result.nextCooldownState);
      previousQuotes = quotes;
      lastSlotKey = slotKey;

      if (result.events.length === 0) {
        const swing = maxSwingPct(quotes);
        console.log(
          `[PULSE] ${beijing.time} 巡航 ${symbols.length} 标的，最大日内 ${swing}，未破阈值，保持静默（不唤醒大脑）。`,
        );
        return;
      }
      for (const event of result.events) {
        const base = cerebellumEventToNotificationEvent(event);
        // MID-04: 活跃唤醒 — a slow-drift anomaly the 3s sentinel missed wakes the brain for a
        // judgement (budget-bounded). Without a brain/budget it falls back to the deterministic alert.
        if (brainProvider && event.wakeBrain && (!budget || budget.tryConsume("brain"))) {
          try {
            const position = positions.find(
              (held) => held.symbol === event.symbol && held.market === event.market,
            );
            const analysis = await analyzeMarketAlert({ event, position }, { brainProvider });
            await push(enrichSentinelNotification(base, analysis));
            continue;
          } catch (error) {
            console.error(`(巡航异动研判失败，改推确定性告警：${error instanceof Error ? error.message : String(error)})`);
          }
        }
        await push(base);
      }
    } catch (error) {
      console.error(`(链式静默巡航本轮失败，已跳过：${error instanceof Error ? error.message : String(error)})`);
    }
  };
}

function dedupePatrolSymbols(
  positions: Position[],
  watchlistEntries: readonly WatchlistEntry[],
): Array<{ symbol: string; market: "SSE" | "SZSE"; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ symbol: string; market: "SSE" | "SZSE"; name: string }> = [];
  for (const p of positions) {
    if (!seen.has(p.symbol)) {
      seen.add(p.symbol);
      out.push({ symbol: p.symbol, market: p.market, name: p.name });
    }
  }
  for (const e of watchlistEntries) {
    if (!seen.has(e.symbol)) {
      seen.add(e.symbol);
      out.push({ symbol: e.symbol, market: e.market, name: e.name });
    }
  }
  return out;
}

function maxSwingPct(quotes: Array<{ changePct: number }>): string {
  const max = quotes.reduce((m, q) => Math.max(m, Math.abs(q.changePct)), 0);
  return `${(max * 100).toFixed(2)}%`;
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
                                         events to Feishu when FEISHU_NOTIFY=1 is set.
  --wake-brain                           On redline (wakeBrain) events, spend one model call to add
                                         an AI judgement to the alert. Idle stays free — only anomalies
                                         wake the brain. Needs a real BRAIN_PROVIDER for real analysis.

Without --live the daemon uses a mock sentinel task and never touches the network. With --live it
reads memory/portfolio positions, fetches real quotes, marks them to market, and alerts on rapid
moves / cost stop-loss. With --live --wake-brain, redline events also get an AI take. The model never
trades, writes the account, or connects to a real broker.
Recommended: npm run sentinel:dev -- --live --wake-brain --interval-ms 30000
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
