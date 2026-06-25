const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** zh weekday label indexed by JS `getUTCDay()` (0 = Sunday). */
const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"] as const;

export interface BeijingDateParts {
  /** `YYYY-MM-DD` in Asia/Shanghai. */
  date: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  dayOfWeek: number;
  /** zh weekday character, e.g. "二" for Tuesday. */
  weekdayZh: string;
}

function normalizeToDate(now: string | Date | undefined): Date {
  const base = now instanceof Date ? now : now !== undefined ? new Date(now) : new Date();
  return Number.isNaN(base.getTime()) ? new Date() : base;
}

/** Resolves an instant to its Beijing calendar date, ISO weekday, and zh weekday. */
export function toBeijingDate(now: string | Date | undefined = new Date()): BeijingDateParts {
  const shifted = new Date(normalizeToDate(now).getTime() + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  const jsDay = shifted.getUTCDay();

  return {
    date: `${year}-${month}-${day}`,
    dayOfWeek: jsDay === 0 ? 7 : jsDay,
    weekdayZh: WEEKDAY_ZH[jsDay]!,
  };
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a `YYYY-MM-DD` Beijing date string. */
export function beijingDayOfWeek(date: string): number {
  const jsDay = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** Human-facing date line for prompts, e.g. "2026-06-24（周二）". */
export function beijingDateLabel(now: string | Date | undefined = new Date()): string {
  const { date, weekdayZh } = toBeijingDate(now);
  return `${date}（周${weekdayZh}）`;
}

/** Full Beijing timestamp for display, e.g. "2026-06-25 08:30:26（北京时间）". */
export function beijingDateTimeLabel(now: string | Date | undefined = new Date()): string {
  const shifted = new Date(normalizeToDate(now).getTime() + BEIJING_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return `${date} ${time}（北京时间）`;
}
