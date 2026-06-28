import { auditEventSchema, type AuditEvent } from "../audit/index.js";
import {
  normalizeWatchlistEntry,
  quoteSnapshotSchema,
  selectHighPriorityWatchlistEntries,
  type QuoteSnapshot,
  type WatchlistEntryInput,
  type WatchlistPriority,
} from "../market/index.js";
import { type Position, positionSchema, roundRatio } from "../portfolio/index.js";
import {
  cerebellumEventSchema,
  type CerebellumEvent,
  type CerebellumEventType,
  type SignalSeverity,
} from "./schemas.js";

export interface MarketSentinelOptions {
  rapidMoveThreshold?: number;
  rapidMoveWindowMs?: number;
  /** 绝对涨跌幅红线: fire when |today's move from prev close| crosses this (default 0.05 = ±5%). */
  absoluteMoveThreshold?: number;
  /** 突破前高红线: fire when latestPrice breaks the previous tick's intraday high by this ratio. Undefined disables it. */
  previousHighBreakoutThreshold?: number;
  positionStopLossRatio?: number;
  watchlistMoveThreshold?: number;
  watchlistObservePriceNearRatio?: number;
  watchlistPriorities?: readonly WatchlistPriority[];
  cooldownMs?: number;
}

export interface MarketSentinelCheckInput {
  quotes: QuoteSnapshot[];
  positions: Position[];
  previousQuotes?: QuoteSnapshot[];
  watchlistEntries?: readonly WatchlistEntryInput[];
  cooldownState?: Record<string, string>;
  now?: Date | string;
  options?: MarketSentinelOptions;
}

export interface MarketSentinelCheckResult {
  checkedAt: string;
  events: CerebellumEvent[];
  nextCooldownState: Record<string, string>;
  auditEvents: AuditEvent[];
}

interface NormalizedMarketSentinelOptions {
  rapidMoveThreshold: number;
  rapidMoveWindowMs: number;
  absoluteMoveThreshold: number;
  previousHighBreakoutThreshold?: number;
  positionStopLossRatio: number;
  watchlistMoveThreshold: number;
  watchlistObservePriceNearRatio: number;
  watchlistPriorities: readonly WatchlistPriority[];
  cooldownMs: number;
}

export function checkMarketSentinel(input: MarketSentinelCheckInput): MarketSentinelCheckResult {
  const options = normalizeOptions(input.options);
  const checkedAt = normalizeDate(input.now).toISOString();
  const quotes = input.quotes.map((quote) => quoteSnapshotSchema.parse(quote));
  const positions = input.positions.map((position) => positionSchema.parse(position));
  const watchlistEntries = (input.watchlistEntries ?? []).map((entry) =>
    normalizeWatchlistEntry(entry, checkedAt),
  );
  const previousQuoteMap = new Map(
    (input.previousQuotes ?? [])
      .map((quote) => quoteSnapshotSchema.parse(quote))
      .map((quote) => [quoteKey(quote), quote] as const),
  );
  const currentQuoteMap = new Map(quotes.map((quote) => [quoteKey(quote), quote] as const));
  const nextCooldownState = { ...(input.cooldownState ?? {}) };
  const candidates: CerebellumEvent[] = [
    ...detectRapidMoveEvents(quotes, previousQuoteMap, checkedAt, options),
    ...detectAbsoluteMoveEvents(quotes, checkedAt, options),
    ...detectPreviousHighBreakoutEvents(quotes, previousQuoteMap, checkedAt, options),
    ...detectStopLossEvents(positions, currentQuoteMap, checkedAt, options),
    ...detectWatchlistEvents(watchlistEntries, currentQuoteMap, checkedAt, options),
  ];
  const events: CerebellumEvent[] = [];

  for (const candidate of candidates) {
    if (isCoolingDown(candidate.cooldownKey, checkedAt, nextCooldownState, options.cooldownMs)) {
      continue;
    }

    events.push(candidate);
    nextCooldownState[candidate.cooldownKey] = checkedAt;
  }

  return {
    checkedAt,
    events,
    nextCooldownState,
    auditEvents: events.map((event) => auditEventForSentinelEvent(event)),
  };
}

function detectRapidMoveEvents(
  quotes: QuoteSnapshot[],
  previousQuoteMap: Map<string, QuoteSnapshot>,
  checkedAt: string,
  options: NormalizedMarketSentinelOptions,
): CerebellumEvent[] {
  return quotes.flatMap((quote) => {
    const previous = previousQuoteMap.get(quoteKey(quote));

    if (!previous || previous.latestPrice <= 0) {
      return [];
    }

    const currentTime = Date.parse(quote.receivedAt);
    const previousTime = Date.parse(previous.receivedAt);

    if (
      Number.isNaN(currentTime) ||
      Number.isNaN(previousTime) ||
      previousTime > currentTime ||
      currentTime - previousTime > options.rapidMoveWindowMs
    ) {
      return [];
    }

    const changePct = roundRatio((quote.latestPrice - previous.latestPrice) / previous.latestPrice);

    if (Math.abs(changePct) < options.rapidMoveThreshold) {
      return [];
    }

    const eventType: CerebellumEventType = changePct > 0 ? "price_surge" : "price_drop";
    const direction = changePct > 0 ? "rapid surge" : "rapid drop";

    return [
      createEvent({
        eventType,
        severity: "warning",
        quote,
        checkedAt,
        currentPrice: quote.latestPrice,
        previousPrice: previous.latestPrice,
        changePct,
        threshold: options.rapidMoveThreshold,
        message: `${quote.name} ${direction} ${formatPct(changePct)} within sentinel window`,
      }),
    ];
  });
}

/**
 * 绝对涨跌幅红线 (±5% by default): fire when a quote's TODAY move (from previous close)
 * crosses the threshold — independent of the rapid-move window. This is the spec's
 * "绝对涨跌幅突破 ±5%" 强弱分界线. Shares the price_surge/price_drop cooldown key with the
 * rapid-move detector, so within the cooldown window the same name alerts at most once.
 */
function detectAbsoluteMoveEvents(
  quotes: QuoteSnapshot[],
  checkedAt: string,
  options: NormalizedMarketSentinelOptions,
): CerebellumEvent[] {
  if (options.absoluteMoveThreshold <= 0) {
    return []; // disabled unless a caller opts in (production daemon sets 0.05)
  }

  return quotes.flatMap((quote) => {
    // Prefer the unit-safe daily move from previous close; fall back to the provider's changePct.
    const dailyMove =
      quote.previousClose !== undefined && quote.previousClose > 0
        ? roundRatio((quote.latestPrice - quote.previousClose) / quote.previousClose)
        : roundRatio(quote.changePct);

    if (Math.abs(dailyMove) < options.absoluteMoveThreshold) {
      return [];
    }

    const eventType: CerebellumEventType = dailyMove > 0 ? "price_surge" : "price_drop";
    const direction = dailyMove > 0 ? "今日涨幅" : "今日跌幅";

    return [
      createEvent({
        eventType,
        severity: "warning",
        quote,
        checkedAt,
        currentPrice: quote.latestPrice,
        previousPrice: quote.previousClose,
        changePct: dailyMove,
        threshold: options.absoluteMoveThreshold,
        message: `${quote.name} ${direction} ${formatPct(dailyMove)} 突破 ±${formatPct(options.absoluteMoveThreshold)} 绝对红线`,
      }),
    ];
  });
}

/**
 * 拉升突破前高: compare the current tick against the previous tick's intraday high.
 * The live daemon opts in with threshold 0, so the first fresh break is alertable
 * and the normal cooldown prevents repeated high-print spam.
 */
function detectPreviousHighBreakoutEvents(
  quotes: QuoteSnapshot[],
  previousQuoteMap: Map<string, QuoteSnapshot>,
  checkedAt: string,
  options: NormalizedMarketSentinelOptions,
): CerebellumEvent[] {
  const threshold = options.previousHighBreakoutThreshold;

  if (threshold === undefined) {
    return [];
  }

  return quotes.flatMap((quote) => {
    const previous = previousQuoteMap.get(quoteKey(quote));
    const previousHigh = previous?.highPrice;

    if (!previous || previousHigh === undefined || previousHigh <= 0) {
      return [];
    }

    if (quote.latestPrice <= previousHigh) {
      return [];
    }

    const breakoutRatio = roundRatio((quote.latestPrice - previousHigh) / previousHigh);

    if (breakoutRatio < threshold) {
      return [];
    }

    return [
      createEvent({
        eventType: "previous_high_breakout",
        severity: "warning",
        quote,
        checkedAt,
        currentPrice: quote.latestPrice,
        previousPrice: previousHigh,
        changePct: breakoutRatio,
        threshold,
        message: `${quote.name} 拉升突破前高 ${previousHigh}，当前 ${quote.latestPrice}，突破幅度 ${formatPct(breakoutRatio)}`,
      }),
    ];
  });
}

function detectStopLossEvents(
  positions: Position[],
  currentQuoteMap: Map<string, QuoteSnapshot>,
  checkedAt: string,
  options: NormalizedMarketSentinelOptions,
): CerebellumEvent[] {
  return positions.flatMap((position) => {
    if (position.quantity <= 0 || position.costPrice <= 0) {
      return [];
    }

    const quote = currentQuoteMap.get(positionKey(position));
    const latestPrice = quote?.latestPrice ?? position.latestPrice;

    if (latestPrice === undefined) {
      return [];
    }

    const lossRatio = roundRatio((position.costPrice - latestPrice) / position.costPrice);

    if (lossRatio < options.positionStopLossRatio) {
      return [];
    }

    return [
      createEvent({
        eventType: "position_stop_loss",
        severity: "critical",
        quote: quote ?? quoteFromPosition(position, latestPrice, checkedAt),
        checkedAt,
        currentPrice: latestPrice,
        previousPrice: position.costPrice,
        changePct: -lossRatio,
        threshold: options.positionStopLossRatio,
        message: `${position.name} reached stop-loss ${formatPct(lossRatio)} from cost ${position.costPrice}`,
      }),
    ];
  });
}

function detectWatchlistEvents(
  watchlistEntries: ReturnType<typeof normalizeWatchlistEntry>[],
  currentQuoteMap: Map<string, QuoteSnapshot>,
  checkedAt: string,
  options: NormalizedMarketSentinelOptions,
): CerebellumEvent[] {
  return selectHighPriorityWatchlistEntries(
    watchlistEntries,
    options.watchlistPriorities,
  ).flatMap((entry) => {
    const quote = currentQuoteMap.get(watchlistEntryQuoteKey(entry));

    if (!quote) {
      return [];
    }

    const events: CerebellumEvent[] = [];

    if (quote.changePct >= options.watchlistMoveThreshold) {
      events.push(
        createEvent({
          eventType: "watchlist_price_surge",
          severity: "warning",
          quote,
          checkedAt,
          currentPrice: quote.latestPrice,
          changePct: roundRatio(quote.changePct),
          threshold: options.watchlistMoveThreshold,
          message: `${quote.name} high-priority watchlist is up ${formatPct(quote.changePct)} today`,
        }),
      );
    }

    if (quote.changePct <= -options.watchlistMoveThreshold) {
      events.push(
        createEvent({
          eventType: "watchlist_price_drop",
          severity: "warning",
          quote,
          checkedAt,
          currentPrice: quote.latestPrice,
          changePct: roundRatio(quote.changePct),
          threshold: options.watchlistMoveThreshold,
          message: `${quote.name} high-priority watchlist is down ${formatPct(quote.changePct)} today`,
        }),
      );
    }

    if (entry.observePrice !== undefined && entry.observePrice > 0) {
      const distanceRatio = roundRatio((quote.latestPrice - entry.observePrice) / entry.observePrice);

      if (Math.abs(distanceRatio) <= options.watchlistObservePriceNearRatio) {
        events.push(
          createEvent({
            eventType: "watchlist_observe_price_near",
            severity: "watch",
            quote,
            checkedAt,
            currentPrice: quote.latestPrice,
            previousPrice: entry.observePrice,
            changePct: distanceRatio,
            threshold: options.watchlistObservePriceNearRatio,
            message: `${quote.name} is near watchlist observe price ${entry.observePrice}`,
          }),
        );
      }
    }

    return events;
  });
}

function createEvent(input: {
  eventType: CerebellumEventType;
  severity: SignalSeverity;
  quote: QuoteSnapshot;
  checkedAt: string;
  currentPrice: number;
  previousPrice?: number;
  changePct?: number;
  threshold: number;
  message: string;
}): CerebellumEvent {
  const cooldownKey = `${input.eventType}:${input.quote.market}:${input.quote.symbol}`;

  return cerebellumEventSchema.parse({
    eventId: `evt-${input.eventType}-${input.quote.symbol}-${input.checkedAt.replace(/\D/g, "")}`,
    eventType: input.eventType,
    severity: input.severity,
    symbol: input.quote.symbol,
    market: input.quote.market,
    name: input.quote.name,
    occurredAt: input.checkedAt,
    message: input.message,
    source: "market_sentinel",
    wakeBrain: true,
    cooldownKey,
    currentPrice: input.currentPrice,
    previousPrice: input.previousPrice,
    changePct: input.changePct,
    threshold: input.threshold,
  });
}

function isCoolingDown(
  cooldownKey: string,
  checkedAt: string,
  cooldownState: Record<string, string>,
  cooldownMs: number,
): boolean {
  const lastEmittedAt = cooldownState[cooldownKey];

  if (!lastEmittedAt) {
    return false;
  }

  const elapsedMs = Date.parse(checkedAt) - Date.parse(lastEmittedAt);
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < cooldownMs;
}

function normalizeOptions(options: MarketSentinelOptions = {}): NormalizedMarketSentinelOptions {
  const normalized = {
    rapidMoveThreshold: options.rapidMoveThreshold ?? 0.02,
    rapidMoveWindowMs: options.rapidMoveWindowMs ?? 60_000,
    // 0 = disabled by default (keeps the pure function's behavior stable); the live
    // sentinel daemon opts in with 0.05 to enforce the spec's ±5% 绝对涨跌幅 redline.
    absoluteMoveThreshold: options.absoluteMoveThreshold ?? 0,
    previousHighBreakoutThreshold: options.previousHighBreakoutThreshold,
    positionStopLossRatio: options.positionStopLossRatio ?? 0.08,
    watchlistMoveThreshold: options.watchlistMoveThreshold ?? 0.03,
    watchlistObservePriceNearRatio: options.watchlistObservePriceNearRatio ?? 0.01,
    watchlistPriorities: options.watchlistPriorities ?? ["high"],
    cooldownMs: options.cooldownMs ?? 600_000,
  };

  assertRatio(normalized.rapidMoveThreshold, "rapidMoveThreshold");
  assertRatio(normalized.absoluteMoveThreshold, "absoluteMoveThreshold");
  if (normalized.previousHighBreakoutThreshold !== undefined) {
    assertRatio(normalized.previousHighBreakoutThreshold, "previousHighBreakoutThreshold");
  }
  assertRatio(normalized.positionStopLossRatio, "positionStopLossRatio");
  assertRatio(normalized.watchlistMoveThreshold, "watchlistMoveThreshold");
  assertRatio(normalized.watchlistObservePriceNearRatio, "watchlistObservePriceNearRatio");

  if (normalized.watchlistPriorities.length === 0) {
    throw new MarketSentinelError("watchlistPriorities must not be empty");
  }

  if (!Number.isFinite(normalized.rapidMoveWindowMs) || normalized.rapidMoveWindowMs <= 0) {
    throw new MarketSentinelError("rapidMoveWindowMs must be a positive number");
  }

  if (!Number.isFinite(normalized.cooldownMs) || normalized.cooldownMs < 0) {
    throw new MarketSentinelError("cooldownMs must be a non-negative number");
  }

  return normalized;
}

function auditEventForSentinelEvent(event: CerebellumEvent): AuditEvent {
  return auditEventSchema.parse({
    eventId: safeIdentifier(`audit-${event.eventId}`),
    occurredAt: event.occurredAt,
    actor: {
      type: "scheduler",
      id: "market-sentinel",
    },
    action: "validate",
    subject: {
      type: "scheduler",
      id: "market-sentinel",
    },
    severity: event.severity === "watch" ? "info" : event.severity,
    result: "success",
    message: `MarketSentinel generated ${event.eventType}`,
    correlationId: safeIdentifier(event.eventId),
    metadata: {
      eventId: event.eventId,
      eventType: event.eventType,
      severity: event.severity,
      symbol: event.symbol,
      market: event.market,
      cooldownKey: event.cooldownKey,
      wakeBrain: event.wakeBrain,
      currentPrice: event.currentPrice,
      previousPrice: event.previousPrice ?? null,
      changePct: event.changePct ?? null,
      threshold: event.threshold,
      source: event.source,
      brainProviderCalled: false,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function assertRatio(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MarketSentinelError(`${name} must be between 0 and 1`);
  }
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new MarketSentinelError("Invalid sentinel date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new MarketSentinelError(`Invalid sentinel date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function quoteFromPosition(position: Position, latestPrice: number, checkedAt: string): QuoteSnapshot {
  return quoteSnapshotSchema.parse({
    symbol: position.symbol,
    market: position.market,
    name: position.name,
    provider: "tencent",
    latestPrice,
    changePct: 0,
    receivedAt: checkedAt,
    rawSymbol: `${position.market === "SSE" ? "sh" : "sz"}${position.symbol}`,
  });
}

function quoteKey(quote: QuoteSnapshot): string {
  return `${quote.market}:${quote.symbol}`;
}

function watchlistEntryQuoteKey(entry: { market: string; symbol: string }): string {
  return `${entry.market}:${entry.symbol}`;
}

function positionKey(position: Position): string {
  return `${position.market}:${position.symbol}`;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "market-sentinel";
}

export class MarketSentinelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSentinelError";
  }
}
