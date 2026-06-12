import { SchedulerError, type Clock } from "./types.js";

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export const BEIJING_TIMEZONE = "Asia/Shanghai";

export interface BeijingDateTime {
  timezone: typeof BEIJING_TIMEZONE;
  date: string;
  time: string;
  isoLocal: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  dayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  minuteOfDay: number;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class BeijingClock implements Clock {
  private readonly source: Clock;

  constructor(source: Clock = new SystemClock()) {
    this.source = source;
  }

  now(): Date {
    return this.source.now();
  }

  nowBeijing(): BeijingDateTime {
    return toBeijingDateTime(this.now());
  }
}

export function toBeijingDateTime(date: Date): BeijingDateTime {
  assertValidDate(date);

  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const millisecond = shifted.getUTCMilliseconds();
  const rawDayOfWeek = shifted.getUTCDay();
  const dayOfWeek = (rawDayOfWeek === 0 ? 7 : rawDayOfWeek) as BeijingDateTime["dayOfWeek"];
  const datePart = `${year}-${pad2(month)}-${pad2(day)}`;
  const timePart = `${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;

  return {
    timezone: BEIJING_TIMEZONE,
    date: datePart,
    time: timePart,
    isoLocal: `${datePart}T${timePart}.${pad3(millisecond)}+08:00`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
    dayOfWeek,
    minuteOfDay: hour * 60 + minute,
  };
}

export function isBeijingWeekday(date: Date): boolean {
  const dayOfWeek = toBeijingDateTime(date).dayOfWeek;
  return dayOfWeek >= 1 && dayOfWeek <= 5;
}

export function parseBeijingTimeOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());

  if (!match) {
    throw new SchedulerError(`Invalid Beijing time of day: ${value}`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatBeijingMinute(minuteOfDay: number): string {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay >= 24 * 60) {
    throw new SchedulerError(`Invalid Beijing minute of day: ${minuteOfDay}`);
  }

  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

export function assertValidDate(date: Date): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new SchedulerError("Invalid date");
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}
