import { parseBeijingTimeOfDay } from "./beijing-clock.js";
import { SchedulerError, type Clock } from "./types.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A deterministic {@link Clock} for replay/backtests. It holds a mutable UTC
 * instant that callers move explicitly — never the wall clock — so a replay is
 * fully reproducible. It implements the same `Clock` interface as `BeijingClock`,
 * so it can later be injected wherever a clock is accepted (P1).
 *
 * `setToBeijingInstant` is the key seam: it positions the clock at a given Beijing
 * wall time on a given day by converting through the flat +8h offset (no DST), so
 * `toCerebellumBeijingTime(clock.now())` round-trips the requested date/hour/minute
 * — including the 00:00 midnight edge (which must resolve to that day, not the day
 * before).
 */
export class SimulatedClock implements Clock {
  private current: Date;

  constructor(initial: Date = new Date(0)) {
    this.assertValid(initial);
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Position the clock at `HH:MM` Beijing wall time on the given `YYYY-MM-DD`. */
  setToBeijingInstant(date: string, timeHHMM: string): void {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) {
      throw new SchedulerError(`Invalid Beijing date: ${date}`);
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const minuteOfDay = parseBeijingTimeOfDay(timeHHMM);

    // Beijing wall instant (Y-M-D HH:MM, +08:00) expressed as a UTC epoch.
    const utcMidnightOfBeijingDay = Date.UTC(year, month - 1, day);
    this.current = new Date(utcMidnightOfBeijingDay + minuteOfDay * 60_000 - BEIJING_OFFSET_MS);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * DAY_MS);
  }

  private assertValid(date: Date): void {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new SchedulerError("SimulatedClock requires a valid Date");
    }
  }
}
