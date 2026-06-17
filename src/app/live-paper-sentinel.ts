import {
  checkMarketSentinel,
  type CerebellumEvent,
  type CerebellumEventType,
  type MarketSentinelOptions,
} from "../domain/cerebellum/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type {
  QuoteSnapshot,
  StockSymbolInfo,
} from "../domain/market/index.js";
import type { Position } from "../domain/portfolio/index.js";

export interface LivePaperSentinelInfo {
  checkedAt: string;
  positionCount: number;
  quoteCount: number;
}

export interface LivePaperSentinelTaskDeps {
  /** Reads the current paper positions from the DB. */
  getPositions: () => Position[];
  /** Fetches live quotes for the held symbols. */
  getQuotes: (symbols: Array<string | StockSymbolInfo>) => Promise<QuoteSnapshot[]>;
  now?: () => Date;
  options?: MarketSentinelOptions;
  /** Called once per tick with the detected events (push/log happens here). */
  onEvents?: (events: CerebellumEvent[], info: LivePaperSentinelInfo) => void | Promise<void>;
  /** Optional mark-to-market: persist updated latest prices back to the DB. */
  persistPositions?: (positions: Position[]) => void;
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
  let cooldownState: Record<string, string> = {};

  return async () => {
    const positions = deps.getPositions();

    if (positions.length === 0) {
      previousQuotes = [];
      await deps.onEvents?.([], {
        checkedAt: (deps.now?.() ?? new Date()).toISOString(),
        positionCount: 0,
        quoteCount: 0,
      });
      return;
    }

    const symbols: StockSymbolInfo[] = positions.map((position) => ({
      symbol: position.symbol,
      market: position.market,
      name: position.name,
    }));
    const quotes = await deps.getQuotes(symbols);
    const result = checkMarketSentinel({
      quotes,
      positions,
      previousQuotes,
      cooldownState,
      now: deps.now?.(),
      options: deps.options,
    });

    cooldownState = result.nextCooldownState;
    previousQuotes = quotes;

    if (deps.persistPositions) {
      maybePersistMarkToMarket(positions, quotes, result.checkedAt, deps.persistPositions);
    }

    await deps.onEvents?.(result.events, {
      checkedAt: result.checkedAt,
      positionCount: positions.length,
      quoteCount: quotes.length,
    });
  };
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
  price_surge: "短时急涨，注意追高风险，必要时人工复核。",
  price_drop: "短时急跌，注意下行风险，必要时人工复核。",
  position_stop_loss: "已触及成本止损线，请人工评估是否减仓（系统不自动下单）。",
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
    recommendedAction: EVENT_ACTIONS[event.eventType] ?? "注意风险，必要时人工复核。",
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
