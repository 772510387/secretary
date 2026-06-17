import { describe, expect, it } from "vitest";
import {
  buildWatchlistSnapshot,
  normalizeWatchlistEntry,
  selectHighPriorityWatchlistEntries,
  watchlistSnapshotSchema,
} from "../../src/domain/market/index.js";

const now = "2026-06-16T01:30:00.000Z";

describe("Watchlist domain", () => {
  it("normalizes manual seed entries and infers A-share market", () => {
    const entry = normalizeWatchlistEntry(
      {
        symbol: "600000",
        name: "Mock Bank",
        priority: "high",
        reason: "Manual seed for morning review.",
        source: "manual_seed",
        observePrice: 12.3,
      },
      now,
    );

    expect(entry).toMatchObject({
      symbol: "600000",
      market: "SSE",
      name: "Mock Bank",
      priority: "high",
      reason: "Manual seed for morning review.",
      source: "manual_seed",
      updatedAt: now,
      observePrice: 12.3,
    });
  });

  it("builds the three supported pool snapshots without touching storage", () => {
    const categories = [
      "watchlist_today",
      "watchlist_long_term",
      "potential_stocks",
    ] as const;

    for (const category of categories) {
      const snapshot = buildWatchlistSnapshot({
        category,
        updatedAt: now,
        entries: [
          {
            symbol: "000001",
            name: "Mock SZ",
            priority: "medium",
            reason: "Manual import.",
            source: "manual_import",
          },
        ],
      });

      expect(watchlistSnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(snapshot.category).toBe(category);
      expect(snapshot.entries[0]).toMatchObject({
        symbol: "000001",
        market: "SZSE",
        updatedAt: now,
      });
    }
  });

  it("deduplicates by market and symbol and selects high-priority entries", () => {
    const snapshot = buildWatchlistSnapshot({
      category: "watchlist_today",
      updatedAt: now,
      entries: [
        {
          symbol: "000001",
          name: "Old",
          priority: "low",
          reason: "Old seed.",
          source: "manual_seed",
        },
        {
          symbol: "000001",
          name: "Updated",
          priority: "high",
          reason: "Updated seed.",
          source: "manual_import",
        },
        {
          symbol: "600000",
          name: "Medium",
          priority: "medium",
          reason: "Manual import.",
          source: "manual_import",
        },
      ],
    });

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      symbol: "000001",
      priority: "high",
      name: "Updated",
    });
    expect(selectHighPriorityWatchlistEntries(snapshot.entries)).toHaveLength(1);
  });
});
