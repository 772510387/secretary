import path from "node:path";
import { z } from "zod";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  buildWatchlistSnapshot,
  normalizeWatchlistEntry,
  watchlistCategorySchema,
  watchlistEntryKey,
  watchlistSnapshotSchema,
  type WatchlistCategory,
  type WatchlistEntry,
  type WatchlistEntryInput,
  type WatchlistSnapshot,
} from "../../domain/market/index.js";
import { appendAuditEvent } from "../logging/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

export interface WatchlistMemoryPaths {
  marketDir: string;
  watchlistsDir: string;
  categoryPath: string;
  auditLogPath: string;
}

export interface WatchlistMemoryStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface WatchlistMemoryWriteResult {
  category: WatchlistCategory;
  filePath: string;
  backupPath?: string;
  auditLogPath: string;
  auditBackupPath?: string;
  entryCount: number;
}

export class WatchlistMemoryStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: WatchlistMemoryStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  readCategory(category: WatchlistCategory): WatchlistSnapshot {
    const parsedCategory = watchlistCategorySchema.parse(category);
    const store = this.createStore(parsedCategory);

    if (!store.exists()) {
      return buildWatchlistSnapshot({
        category: parsedCategory,
        entries: [],
        updatedAt: this.isoNow(),
      });
    }

    return store.read();
  }

  writeCategory(snapshot: WatchlistSnapshot): WatchlistMemoryWriteResult {
    const occurredAt = this.isoNow();
    const parsed = watchlistSnapshotSchema.parse(snapshot);
    const paths = createWatchlistMemoryPaths(this.memoryDir, parsed.category, occurredAt);
    const result = this.createStore(parsed.category).write(parsed);
    const auditWrite = appendAuditEvent(
      paths.auditLogPath,
      auditEventForWatchlistSnapshot(parsed, {
        occurredAt,
        eventId: `audit-watchlist-${safeIdentifier(this.idGenerator())}`,
        filePath: result.filePath,
        backupPath: result.backupPath,
      }),
      this.writer,
    );

    return {
      category: parsed.category,
      filePath: result.filePath,
      backupPath: result.backupPath,
      auditLogPath: auditWrite.filePath,
      auditBackupPath: auditWrite.backupPath,
      entryCount: parsed.entries.length,
    };
  }

  importEntries(
    category: WatchlistCategory,
    entries: readonly WatchlistEntryInput[],
  ): WatchlistMemoryWriteResult {
    const importedAt = this.isoNow();
    const current = this.readCategory(category);
    const imported = entries.map((entry) => normalizeWatchlistEntry(entry, importedAt));
    const merged = mergeEntries([...current.entries, ...imported]);
    const snapshot = buildWatchlistSnapshot({
      category,
      entries: merged,
      updatedAt: importedAt,
      metadata: {
        ...current.metadata,
        lastImportAt: importedAt,
        manualSeedOrImport: true,
        webSearchUsed: false,
        brainProviderCalled: false,
        brokerConnected: false,
        liveTrading: false,
      },
    });

    return this.writeCategory(snapshot);
  }

  private createStore(category: WatchlistCategory): JsonStore<WatchlistSnapshot> {
    const paths = createWatchlistMemoryPaths(this.memoryDir, category, this.isoNow());

    return new JsonStore<WatchlistSnapshot>({
      filePath: paths.categoryPath,
      schema: watchlistSnapshotSchema as z.ZodType<WatchlistSnapshot>,
      writer: this.writer,
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("WatchlistMemoryStore now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

export function createWatchlistMemoryPaths(
  memoryDir: string,
  category: WatchlistCategory,
  occurredAt?: string,
): WatchlistMemoryPaths {
  const parsedCategory = watchlistCategorySchema.parse(category);
  const resolvedMemoryDir = path.resolve(memoryDir);
  const marketDir = path.join(resolvedMemoryDir, "market");
  const watchlistsDir = path.join(marketDir, "watchlists");
  const auditDate = (occurredAt ?? new Date().toISOString()).slice(0, 10);

  return {
    marketDir,
    watchlistsDir,
    categoryPath: path.join(watchlistsDir, `${parsedCategory}.json`),
    auditLogPath: path.join(resolvedMemoryDir, "logs", `audit-${auditDate}.jsonl`),
  };
}

function auditEventForWatchlistSnapshot(
  snapshot: WatchlistSnapshot,
  options: {
    occurredAt: string;
    eventId: string;
    filePath: string;
    backupPath?: string;
  },
): AuditEvent {
  return auditEventSchema.parse({
    eventId: options.eventId,
    occurredAt: options.occurredAt,
    actor: {
      type: "system",
      id: "watchlist-memory-store",
    },
    action: "write",
    subject: {
      type: "memory",
      id: safeIdentifier(`watchlist-${snapshot.category}`),
    },
    severity: "info",
    result: "success",
    message: `Watchlist ${snapshot.category} written`,
    metadata: {
      category: snapshot.category,
      entryCount: snapshot.entries.length,
      symbols: snapshot.entries.map((entry) => watchlistEntryKey(entry)),
      highPriorityCount: snapshot.entries.filter((entry) => entry.priority === "high").length,
      filePath: path.normalize(options.filePath),
      backupPath: options.backupPath ? path.normalize(options.backupPath) : null,
      manualSeedOrImport: true,
      webSearchUsed: false,
      brainProviderCalled: false,
      brokerConnected: false,
      liveTrading: false,
    },
  });
}

function mergeEntries(entries: readonly WatchlistEntry[]): WatchlistEntry[] {
  const byKey = new Map<string, WatchlistEntry>();

  for (const entry of entries) {
    byKey.set(watchlistEntryKey(entry), entry);
  }

  return [...byKey.values()].sort((left, right) => {
    const priority = priorityWeight(right.priority) - priorityWeight(left.priority);

    if (priority !== 0) {
      return priority;
    }

    const market = left.market.localeCompare(right.market);

    if (market !== 0) {
      return market;
    }

    return left.symbol.localeCompare(right.symbol);
  });
}

function priorityWeight(priority: WatchlistEntry["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "watchlist";
}
