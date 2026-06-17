import { z } from "zod";
import {
  isoDateTimeSchema,
  jsonValueSchema,
  positiveMoneySchema,
  stockMarketSchema,
  stockSymbolSchema,
  type JsonValue,
} from "../shared/index.js";
import { inferAshareMarket } from "./symbols.js";

export const watchlistCategorySchema = z.enum([
  "watchlist_today",
  "watchlist_long_term",
  "potential_stocks",
]);

export const watchlistPrioritySchema = z.enum(["low", "medium", "high"]);

export const watchlistEntryInputSchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema.optional(),
    name: z.string().trim().min(1).max(80),
    priority: watchlistPrioritySchema,
    reason: z.string().trim().min(1).max(1000),
    source: z.string().trim().min(1).max(120),
    updatedAt: isoDateTimeSchema.optional(),
    observePrice: positiveMoneySchema.optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const watchlistEntrySchema = z
  .object({
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    priority: watchlistPrioritySchema,
    reason: z.string().trim().min(1).max(1000),
    source: z.string().trim().min(1).max(120),
    updatedAt: isoDateTimeSchema,
    observePrice: positiveMoneySchema.optional(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export const watchlistSnapshotSchema = z
  .object({
    category: watchlistCategorySchema,
    updatedAt: isoDateTimeSchema,
    entries: z.array(watchlistEntrySchema).default([]),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const seen = new Map<string, number>();

    snapshot.entries.forEach((entry, index) => {
      const key = watchlistEntryKey(entry);
      const previous = seen.get(key);

      if (previous !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "symbol"],
          message: `Duplicate watchlist entry ${key}; first seen at entries.${previous}`,
        });
      }

      seen.set(key, index);
    });
  });

export type WatchlistCategory = z.infer<typeof watchlistCategorySchema>;
export type WatchlistPriority = z.infer<typeof watchlistPrioritySchema>;
export type WatchlistEntryInput = z.input<typeof watchlistEntryInputSchema>;
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;
export type WatchlistSnapshot = z.infer<typeof watchlistSnapshotSchema>;

export interface BuildWatchlistSnapshotInput {
  category: WatchlistCategory;
  entries?: readonly WatchlistEntryInput[];
  updatedAt?: Date | string;
  metadata?: Record<string, JsonValue>;
}

export function normalizeWatchlistEntry(
  input: WatchlistEntryInput,
  defaultUpdatedAt?: Date | string,
): WatchlistEntry {
  const parsed = watchlistEntryInputSchema.parse(input);
  const updatedAt = normalizeDate(parsed.updatedAt ?? defaultUpdatedAt).toISOString();

  return watchlistEntrySchema.parse({
    ...parsed,
    market: parsed.market ?? inferAshareMarket(parsed.symbol),
    updatedAt,
  });
}

export function buildWatchlistSnapshot(input: BuildWatchlistSnapshotInput): WatchlistSnapshot {
  const updatedAt = normalizeDate(input.updatedAt).toISOString();
  const entries = mergeWatchlistEntries(
    (input.entries ?? []).map((entry) => normalizeWatchlistEntry(entry, updatedAt)),
  );

  return watchlistSnapshotSchema.parse({
    category: input.category,
    updatedAt,
    entries,
    metadata: input.metadata ?? {},
  });
}

export function selectHighPriorityWatchlistEntries(
  entries: readonly WatchlistEntry[],
  priorities: readonly WatchlistPriority[] = ["high"],
): WatchlistEntry[] {
  const accepted = new Set(priorities);
  return mergeWatchlistEntries(entries).filter((entry) => accepted.has(entry.priority));
}

export function watchlistEntryKey(entry: Pick<WatchlistEntry, "market" | "symbol">): string {
  return `${entry.market}:${entry.symbol}`;
}

function mergeWatchlistEntries(entries: readonly WatchlistEntry[]): WatchlistEntry[] {
  const byKey = new Map<string, WatchlistEntry>();

  for (const entry of entries) {
    const parsed = watchlistEntrySchema.parse(entry);
    byKey.set(watchlistEntryKey(parsed), parsed);
  }

  return [...byKey.values()].sort(compareWatchlistEntries);
}

function compareWatchlistEntries(left: WatchlistEntry, right: WatchlistEntry): number {
  const priority = priorityWeight(right.priority) - priorityWeight(left.priority);

  if (priority !== 0) {
    return priority;
  }

  const market = left.market.localeCompare(right.market);

  if (market !== 0) {
    return market;
  }

  return left.symbol.localeCompare(right.symbol);
}

function priorityWeight(priority: WatchlistPriority): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new WatchlistError("Invalid watchlist date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new WatchlistError(`Invalid watchlist date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

export class WatchlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchlistError";
  }
}
