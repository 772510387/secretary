import {
  parseBeijingTimeOfDay,
  toBeijingDateTime,
} from "./beijing-clock.js";
import { SchedulerError } from "./types.js";

export interface TradingSessionRange {
  start: string;
  end: string;
}

export interface TradingSessionOptions {
  weekdayOnly?: boolean;
  sessions?: TradingSessionRange[];
}

export const A_SHARE_MARKET_SESSIONS: TradingSessionRange[] = [
  { start: "09:30", end: "11:30" },
  { start: "13:00", end: "15:00" },
];

export class TradingDayScheduler {
  private readonly options: Required<TradingSessionOptions>;

  constructor(options: TradingSessionOptions = {}) {
    this.options = normalizeTradingSessionOptions(options);
  }

  isMarketOpen(date: Date): boolean {
    return isWithinTradingSession(date, this.options);
  }
}

export function isWithinTradingSession(
  date: Date,
  options: TradingSessionOptions = {},
): boolean {
  const normalized = normalizeTradingSessionOptions(options);
  const beijingTime = toBeijingDateTime(date);

  if (normalized.weekdayOnly && beijingTime.dayOfWeek > 5) {
    return false;
  }

  return normalized.sessions.some((session) => {
    const start = parseBeijingTimeOfDay(session.start);
    const end = parseBeijingTimeOfDay(session.end);
    return beijingTime.minuteOfDay >= start && beijingTime.minuteOfDay < end;
  });
}

function normalizeTradingSessionOptions(
  options: TradingSessionOptions,
): Required<TradingSessionOptions> {
  const sessions = options.sessions ?? A_SHARE_MARKET_SESSIONS;

  if (sessions.length === 0) {
    throw new SchedulerError("At least one trading session is required");
  }

  for (const session of sessions) {
    const start = parseBeijingTimeOfDay(session.start);
    const end = parseBeijingTimeOfDay(session.end);

    if (start >= end) {
      throw new SchedulerError(`Trading session start must be before end: ${session.start}-${session.end}`);
    }
  }

  return {
    weekdayOnly: options.weekdayOnly ?? true,
    sessions,
  };
}
