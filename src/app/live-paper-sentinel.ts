import {
  checkMarketSentinel,
  detectIndexSystemicRisk,
  type CerebellumEvent,
  type CerebellumEventType,
  type IndexRiskRadarOptions,
  type MarketSentinelOptions,
} from "../domain/cerebellum/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type {
  IndexSnapshot,
  QuoteSnapshot,
  StockSymbolInfo,
  VolumePriceSignal,
  VolumePriceSignalOptions,
  WatchlistEntryInput,
} from "../domain/market/index.js";
import { calculateQuoteVolumePriceSignal } from "../domain/market/index.js";
import type { Position } from "../domain/portfolio/index.js";

export interface LivePaperSentinelInfo {
  checkedAt: string;
  positionCount: number;
  quoteCount: number;
}

export interface LivePaperSentinelTaskDeps {
  /** Reads the current paper positions from the DB. */
  getPositions: () => Position[];
  /** Optional: reads watchlist entries to also scan high-priority names intraday. */
  getWatchlistEntries?: () => readonly WatchlistEntryInput[];
  /** Fetches live quotes for the held + watchlist symbols. */
  getQuotes: (symbols: Array<string | StockSymbolInfo>) => Promise<QuoteSnapshot[]>;
  now?: () => Date;
  options?: MarketSentinelOptions;
  /** Seed cooldown state from disk (alert_state.json) so a restart doesn't re-spam alerts. */
  initialCooldownState?: Record<string, string>;
  /** Persist cooldown state after each tick (to alert_state.json), shared with the patrol. */
  onCooldownState?: (state: Record<string, string>) => void;
  /** Called once per tick with the detected events (push/log happens here). */
  onEvents?: (events: CerebellumEvent[], info: LivePaperSentinelInfo) => void | Promise<void>;
  /** Optional mark-to-market: persist updated latest prices back to the DB. */
  persistPositions?: (positions: Position[]) => void;
  /** Optional: fetch market index snapshots to run the systemic-risk radar. */
  getIndexSnapshots?: () => Promise<IndexSnapshot[]>;
  indexOptions?: IndexRiskRadarOptions;
  /** Called with index/systemic-risk notifications (大盘急跌/系统性风险). */
  onIndexNotifications?: (notifications: NotificationEvent[]) => void | Promise<void>;
  /**
   * Optional volume-price radar. It compares quote volume deltas between ticks
   * against a rolling baseline and emits deterministic non-order signals.
   */
  volumeOptions?: VolumePriceSignalOptions & { baselineWindow?: number };
  onVolumePriceSignals?: (
    signals: VolumePriceSignal[],
    info: LivePaperSentinelInfo,
  ) => void | Promise<void>;
  onVolumePriceNotifications?: (notifications: NotificationEvent[]) => void | Promise<void>;
}

export type LivePaperSentinelTask = () => Promise<void>;

/**
 * Builds a resident-daemon task that watches the paper positions against live
 * quotes: each tick it reads positions, fetches real quotes, runs the
 * deterministic MarketSentinel (rapid move / cost stop-loss), optionally marks
 * positions to market in the DB, and hands the detected events to `onEvents`.
 *
 * Rapid-move detection and cooldown state are carried across ticks in the
 * closure, so the same alert is not re-sent within the cooldown window. The task
 * never calls the brain, never trades, and never connects to a real broker.
 */
export function createLivePaperSentinelTask(deps: LivePaperSentinelTaskDeps): LivePaperSentinelTask {
  let previousQuotes: QuoteSnapshot[] = [];
  let cooldownState: Record<string, string> = deps.initialCooldownState
    ? { ...deps.initialCooldownState }
    : {};
  let previousIndexSnapshots: IndexSnapshot[] = [];
  const volumeBaselines = new Map<string, number[]>();

  return async () => {
    const positions = deps.getPositions();
    const watchlistEntries = deps.getWatchlistEntries?.() ?? [];

    if (positions.length === 0 && watchlistEntries.length === 0) {
      previousQuotes = [];
      await deps.onEvents?.([], {
        checkedAt: (deps.now?.() ?? new Date()).toISOString(),
        positionCount: 0,
        quoteCount: 0,
      });
    } else {
      const symbols = dedupeSymbols([
        ...positions.map((position) => ({
          symbol: position.symbol,
          market: position.market,
          name: position.name,
        })),
        ...watchlistEntries.map((entry) =>
          entry.market
            ? { symbol: entry.symbol, market: entry.market, name: entry.name }
            : entry.symbol,
        ),
      ]);
      const quotes = await deps.getQuotes(symbols);
      const result = checkMarketSentinel({
        quotes,
        positions,
        watchlistEntries,
        previousQuotes,
        cooldownState,
        now: deps.now?.(),
        options: deps.options,
      });
      const volumeSignals = detectVolumePriceSignals({
        quotes,
        previousQuotes,
        baselines: volumeBaselines,
        options: deps.volumeOptions,
      });

      cooldownState = result.nextCooldownState;
      deps.onCooldownState?.(cooldownState);
      previousQuotes = quotes;

      if (deps.persistPositions && positions.length > 0) {
        maybePersistMarkToMarket(positions, quotes, result.checkedAt, deps.persistPositions);
      }

      await deps.onEvents?.(result.events, {
        checkedAt: result.checkedAt,
        positionCount: positions.length,
        quoteCount: quotes.length,
      });

      if (volumeSignals.length > 0) {
        const info = {
          checkedAt: result.checkedAt,
          positionCount: positions.length,
          quoteCount: quotes.length,
        };
        await deps.onVolumePriceSignals?.(volumeSignals, info);
        await deps.onVolumePriceNotifications?.(
          volumeSignals.map(volumePriceSignalToNotificationEvent),
        );
      }
    }

    // Market index / systemic-risk radar runs independently of holdings.
    if (deps.getIndexSnapshots) {
      const current = await deps.getIndexSnapshots();
      const radar = detectIndexSystemicRisk({
        snapshots: [...previousIndexSnapshots, ...current],
        now: deps.now?.(),
        options: deps.indexOptions,
      });
      previousIndexSnapshots = current;

      if (radar.notifications.length > 0) {
        await deps.onIndexNotifications?.(radar.notifications);
      }
    }
  };
}

function detectVolumePriceSignals(input: {
  quotes: QuoteSnapshot[];
  previousQuotes: QuoteSnapshot[];
  baselines: Map<string, number[]>;
  options?: VolumePriceSignalOptions & { baselineWindow?: number };
}): VolumePriceSignal[] {
  const previousByKey = new Map(input.previousQuotes.map((quote) => [quoteKey(quote), quote]));
  const signals: VolumePriceSignal[] = [];
  const baselineWindow = input.options?.baselineWindow ?? 20;

  for (const quote of input.quotes) {
    const previous = previousByKey.get(quoteKey(quote));
    if (quote.volume === undefined || previous?.volume === undefined) {
      continue;
    }

    const delta = quote.volume - previous.volume;
    if (delta < 0) {
      input.baselines.set(quoteKey(quote), []);
      continue;
    }

    const baseline = input.baselines.get(quoteKey(quote)) ?? [];
    const averageVolume = baseline.length > 0
      ? baseline.reduce((sum, value) => sum + value, 0) / baseline.length
      : undefined;
    const signal = calculateQuoteVolumePriceSignal({
      quote: { ...quote, volume: delta },
      previousPrice: previous.latestPrice,
      averageVolume,
      options: input.options,
    });

    if (isAlertableVolumeSignal(signal)) {
      signals.push(signal);
    }

    const nextBaseline = [...baseline, delta].slice(-baselineWindow);
    input.baselines.set(quoteKey(quote), nextBaseline);
  }

  return signals;
}

function quoteKey(quote: QuoteSnapshot): string {
  return `${quote.market}:${quote.symbol}`;
}

function isAlertableVolumeSignal(signal: VolumePriceSignal): boolean {
  return signal.labels.some((label) =>
    label === "volume_surge" ||
    label === "volume_price_rise" ||
    label === "volume_stagnation" ||
    label === "suspended_or_no_volume",
  );
}

function dedupeSymbols(
  items: Array<string | StockSymbolInfo>,
): Array<string | StockSymbolInfo> {
  const seen = new Set<string>();
  const result: Array<string | StockSymbolInfo> = [];

  for (const item of items) {
    const key = typeof item === "string" ? item : item.symbol;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function maybePersistMarkToMarket(
  positions: Position[],
  quotes: QuoteSnapshot[],
  checkedAt: string,
  persist: (positions: Position[]) => void,
): void {
  const priceMap = new Map(quotes.map((quote) => [`${quote.market}:${quote.symbol}`, quote.latestPrice]));
  let changed = false;
  const updated = positions.map((position) => {
    const latestPrice = priceMap.get(`${position.market}:${position.symbol}`);

    if (latestPrice === undefined || latestPrice === position.latestPrice) {
      return position;
    }

    changed = true;
    return { ...position, latestPrice, updatedAt: checkedAt };
  });

  if (changed) {
    persist(updated);
  }
}

const EVENT_LABELS: Record<CerebellumEventType, string> = {
  price_surge: "急速拉升",
  price_drop: "急速跳水",
  position_stop_loss: "触及成本止损线",
  watchlist_price_surge: "自选股急涨",
  watchlist_price_drop: "自选股急跌",
  watchlist_observe_price_near: "接近自选观察价",
};

const EVENT_ACTIONS: Record<CerebellumEventType, string> = {
  price_surge: "短时急涨，注意追高风险。",
  price_drop: "短时急跌，注意下行风险。",
  position_stop_loss: "已触及成本止损线，关注是否减仓（盘中达 8% 会自动强平）。",
  watchlist_price_surge: "自选股异动，关注是否进入。",
  watchlist_price_drop: "自选股异动，关注下行风险。",
  watchlist_observe_price_near: "已接近你设定的观察价，留意。",
};

/** Converts a sentinel event into a de-identified, pushable NotificationEvent. */
export function cerebellumEventToNotificationEvent(event: CerebellumEvent): NotificationEvent {
  const label = EVENT_LABELS[event.eventType] ?? event.eventType;
  const pct = event.changePct === undefined ? "n/a" : `${(event.changePct * 100).toFixed(2)}%`;

  return notificationEventSchema.parse({
    eventId: `ntf-${event.eventId}`.slice(0, 128),
    occurredAt: event.occurredAt,
    severity: event.severity,
    source: { type: "cerebellum", id: "market-sentinel" },
    target: {
      type: "symbol",
      symbol: event.symbol,
      market: event.market,
      name: event.name,
    },
    summary: `${event.name}(${event.symbol}) ${label}：现价 ${event.currentPrice}，幅度 ${pct}`,
    recommendedAction: EVENT_ACTIONS[event.eventType] ?? "注意风险。",
    dedupeKey: event.cooldownKey,
    cooldownKey: event.cooldownKey,
    channels: ["console", "file", "wechat"],
    metadata: {
      eventType: event.eventType,
      threshold: event.threshold,
      currentPrice: event.currentPrice,
      changePct: event.changePct ?? null,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

/** Converts a deterministic volume-price signal into a pushable notification. */
export function volumePriceSignalToNotificationEvent(signal: VolumePriceSignal): NotificationEvent {
  const primaryLabel = signal.labels.find((label) => label !== "low_liquidity") ?? signal.labels[0]!;
  const label = VOLUME_PRICE_LABELS[primaryLabel] ?? primaryLabel;
  const pct =
    signal.priceChangePct === undefined ? "n/a" : `${(signal.priceChangePct * 100).toFixed(2)}%`;
  const relative =
    signal.relativeVolume === undefined ? "n/a" : `${signal.relativeVolume.toFixed(2)}x`;

  return notificationEventSchema.parse({
    eventId: `ntf-${signal.signalId}`.slice(0, 128),
    occurredAt: signal.asOf,
    severity: volumeSignalSeverity(signal),
    source: { type: "cerebellum", id: "volume-price-radar" },
    target: {
      type: "symbol",
      symbol: signal.symbol,
      market: signal.market,
      name: signal.name,
    },
    summary: `${signal.name ?? signal.symbol}(${signal.symbol}) ${label}：区间量 ${signal.latestVolume ?? "n/a"}，相对均量 ${relative}，价格变化 ${pct}`,
    recommendedAction: "量价异动，纳入观察。",
    dedupeKey: `volume_price:${signal.market}:${signal.symbol}:${primaryLabel}`,
    cooldownKey: `volume_price:${signal.market}:${signal.symbol}:${primaryLabel}`,
    channels: ["console", "file", "wechat"],
    metadata: {
      signalId: signal.signalId,
      labels: signal.labels,
      liquidity: signal.liquidity,
      latestVolume: signal.latestVolume ?? null,
      averageVolume: signal.averageVolume ?? null,
      relativeVolume: signal.relativeVolume ?? null,
      priceChangePct: signal.priceChangePct ?? null,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

const VOLUME_PRICE_LABELS: Record<string, string> = {
  volume_surge: "成交量骤增",
  volume_price_rise: "量价齐升",
  volume_stagnation: "爆量滞涨",
  suspended_or_no_volume: "无量/疑似停牌",
};

function volumeSignalSeverity(signal: VolumePriceSignal): NotificationEvent["severity"] {
  if (signal.labels.includes("suspended_or_no_volume")) {
    return "watch";
  }

  if (signal.labels.includes("volume_stagnation")) {
    return "warning";
  }

  if (signal.labels.includes("volume_price_rise") || signal.labels.includes("volume_surge")) {
    return "warning";
  }

  return "info";
}
