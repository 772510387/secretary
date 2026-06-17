import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import { watchlistSnapshotSchema } from "../../src/domain/market/index.js";
import {
  WatchlistMemoryStore,
  createWatchlistMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const now = "2026-06-16T01:30:00.000Z";

describe("WatchlistMemoryStore", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("imports manual seed entries into a category file with metadata-only audit", () => {
    const memoryDir = createTempMemoryDir();
    const store = new WatchlistMemoryStore({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator(),
    });

    const result = store.importEntries("watchlist_today", [
      {
        symbol: "000001",
        name: "Mock SZ",
        priority: "high",
        reason: "Manual seed reason should stay in the watchlist file only.",
        source: "manual_seed",
        observePrice: 10.5,
      },
    ]);
    const paths = createWatchlistMemoryPaths(memoryDir, "watchlist_today", now);

    expect(result).toMatchObject({
      category: "watchlist_today",
      filePath: paths.categoryPath,
      auditLogPath: paths.auditLogPath,
      entryCount: 1,
    });
    expect(existsSync(paths.categoryPath)).toBe(true);
    expect(existsSync(paths.auditLogPath)).toBe(true);

    const snapshot = watchlistSnapshotSchema.parse(
      JSON.parse(readFileSync(paths.categoryPath, "utf8")),
    );
    expect(snapshot).toMatchObject({
      category: "watchlist_today",
      updatedAt: now,
      metadata: {
        manualSeedOrImport: true,
        webSearchUsed: false,
        brainProviderCalled: false,
        brokerConnected: false,
        liveTrading: false,
      },
    });
    expect(snapshot.entries[0]).toMatchObject({
      symbol: "000001",
      market: "SZSE",
      priority: "high",
      reason: "Manual seed reason should stay in the watchlist file only.",
      observePrice: 10.5,
      updatedAt: now,
    });

    const auditEvents = readAuditEvents(paths.auditLogPath);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      actor: {
        type: "system",
        id: "watchlist-memory-store",
      },
      action: "write",
      subject: {
        type: "memory",
        id: "watchlist-watchlist_today",
      },
      metadata: {
        category: "watchlist_today",
        entryCount: 1,
        symbols: ["SZSE:000001"],
        highPriorityCount: 1,
        webSearchUsed: false,
        brainProviderCalled: false,
        brokerConnected: false,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain("Manual seed reason");
  });

  it("merges later manual imports, creates backups, and supports all pools", () => {
    const memoryDir = createTempMemoryDir();
    const store = new WatchlistMemoryStore({
      memoryDir,
      now: () => new Date(now),
      idGenerator: createIdGenerator(),
    });

    store.importEntries("watchlist_long_term", [
      {
        symbol: "600000",
        name: "Old Name",
        priority: "low",
        reason: "Initial seed.",
        source: "manual_seed",
      },
    ]);
    const second = store.importEntries("watchlist_long_term", [
      {
        symbol: "600000",
        name: "Updated Name",
        priority: "high",
        reason: "Manual import update.",
        source: "manual_import",
      },
      {
        symbol: "000002",
        name: "Potential",
        priority: "medium",
        reason: "Long-term manual import.",
        source: "manual_import",
      },
    ]);
    const potential = store.importEntries("potential_stocks", [
      {
        symbol: "000003",
        name: "Potential Pool",
        priority: "high",
        reason: "Manual potential pool seed.",
        source: "manual_seed",
      },
    ]);

    expect(second.backupPath).toBeDefined();
    expect(second.entryCount).toBe(2);
    expect(potential.category).toBe("potential_stocks");
    expect(store.readCategory("watchlist_long_term").entries).toEqual([
      expect.objectContaining({
        symbol: "600000",
        market: "SSE",
        priority: "high",
        name: "Updated Name",
      }),
      expect.objectContaining({
        symbol: "000002",
        market: "SZSE",
        priority: "medium",
      }),
    ]);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-watchlist-memory-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function readAuditEvents(filePath: string) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => auditEventSchema.parse(JSON.parse(line)));
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return `test-${id}`;
  };
}
