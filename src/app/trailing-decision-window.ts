/**
 * Decisions can only be SCORED against forward outcomes that already exist, so the
 * daily "score & persist" job must run over a TRAILING window of already-settled
 * trading days — never today. This pure helper computes that window in Beijing time
 * (skipping weekends) so the scoring entry (scripts/dev/score-decisions.ts) and the
 * opt-in daemon hook share one deterministic definition and can be unit-tested
 * without any network or clock dependency at call sites.
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface TrailingDecisionWindow {
  /** First Beijing trading date in the window (YYYY-MM-DD). */
  from: string;
  /** Last Beijing trading date in the window (YYYY-MM-DD). */
  to: string;
}

export interface ResolveTrailingDecisionWindowInput {
  /** "Now" instant; defaults to the call-time clock. */
  now?: Date | string;
  /** Number of trailing trading days in the window. */
  windowTradingDays?: number;
  /**
   * Trading days to step back from "today" before the window ENDS, so the most
   * recent decision still has a full forward horizon of realised bars to score
   * against. Must be > the scoring horizon.
   */
  settleLagTradingDays?: number;
}

export function resolveTrailingDecisionWindow(
  input: ResolveTrailingDecisionWindowInput = {},
): TrailingDecisionWindow {
  const windowTradingDays = clampPositiveInt(input.windowTradingDays, 10);
  const settleLagTradingDays = clampPositiveInt(input.settleLagTradingDays, 6);

  const beijingToday = beijingDateOnly(normalizeDate(input.now));
  // Step back `settleLag` trading days for the window end…
  const to = stepBackTradingDays(beijingToday, settleLagTradingDays);
  // …then `windowTradingDays - 1` more for the window start (inclusive window).
  const from = stepBackTradingDays(to, Math.max(0, windowTradingDays - 1));

  return { from: formatDate(from), to: formatDate(to) };
}

function stepBackTradingDays(start: Date, tradingDays: number): Date {
  const cursor = new Date(start.getTime());
  let remaining = tradingDays;
  // First make sure we land on a weekday even if `tradingDays === 0`.
  while (isWeekend(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!isWeekend(cursor)) {
      remaining -= 1;
    }
  }
  return cursor;
}

/** Returns a UTC-midnight Date carrying the Beijing calendar date of `instant`. */
function beijingDateOnly(instant: Date): Date {
  const shifted = new Date(instant.getTime() + BEIJING_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error("resolveTrailingDecisionWindow: invalid Date");
    }
    return value;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`resolveTrailingDecisionWindow: invalid date string ${value}`);
    }
    return parsed;
  }
  return new Date();
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}
