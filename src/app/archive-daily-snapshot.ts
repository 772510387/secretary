import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  calculatePortfolioValuation,
  type Account,
  type PortfolioValuation,
  type Position,
} from "../domain/portfolio/index.js";
import { AtomicFileWriter } from "../infrastructure/storage/index.js";

export interface ArchiveDailySnapshotInput {
  memoryDir: string;
  account: Account;
  positions: Position[];
  /** Latest prices by symbol for mark-to-market; omit to value at cost. */
  prices?: Record<string, number>;
  /** The trading day this snapshot belongs to (YYYY-MM-DD). */
  tradingDate: string;
  /** ISO timestamp the archive was produced; accepted for determinism in tests. */
  now?: string;
  t1Enabled?: boolean;
  /** Injectable for tests; defaults to a real AtomicFileWriter. */
  writer?: AtomicFileWriter;
}

/**
 * The one-line-per-day digest appended to daily-summary.jsonl. Intentionally a flat
 * scalar bag (no nested objects) so the file stays grep/tail friendly for humans and
 * trivially parseable by later review tooling.
 */
export interface DailySnapshotSummary {
  tradingDate: string;
  totalAssets: number;
  availableCash: number;
  investedRatio: number;
  positionCount: number;
  totalUnrealizedPnl: number;
  generatedAt: string;
}

export interface ArchiveDailySnapshotResult {
  summary: DailySnapshotSummary;
  snapshotPath: string;
  summaryPath: string;
}

const TRADING_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 盘后15:30落库归档: persists a deterministic end-of-day archive of the paper account.
 *
 * Two artifacts, both keyed by tradingDate so a re-run for the same day is idempotent:
 *  - a FULL snapshot JSON (account + valued positions + summary) at
 *    `<memoryDir>/portfolio/snapshots/<tradingDate>.json` (overwritten in place), and
 *  - a one-line {@link DailySnapshotSummary} UPSERTed into
 *    `<memoryDir>/portfolio/daily-summary.jsonl` (the existing line for the date is
 *    replaced rather than duplicated — that is the whole point of keying by date).
 *
 * Pure/offline: it only does arithmetic via {@link calculatePortfolioValuation} and
 * atomic file writes. No model, no network.
 */
export function archiveDailySnapshot(
  input: ArchiveDailySnapshotInput,
): ArchiveDailySnapshotResult {
  const { tradingDate } = input;

  // Validate up front so we never write a file under a malformed/path-injecting key.
  if (!TRADING_DATE_PATTERN.test(tradingDate)) {
    throw new ArchiveDailySnapshotError(
      `tradingDate must be YYYY-MM-DD, received "${tradingDate}"`,
    );
  }

  const writer = input.writer ?? new AtomicFileWriter();
  const generatedAt = normalizeNow(input.now);
  const t1Enabled = input.t1Enabled ?? true;

  const valuation = calculatePortfolioValuation(input.account, input.positions, {
    prices: input.prices,
    t1Enabled,
  });

  const summary: DailySnapshotSummary = {
    tradingDate,
    totalAssets: valuation.totalAssets,
    availableCash: valuation.cash.available,
    investedRatio: valuation.investedRatio,
    positionCount: valuation.positions.length,
    totalUnrealizedPnl: valuation.totalUnrealizedPnl,
    generatedAt,
  };

  const resolvedMemoryDir = path.resolve(input.memoryDir);
  const portfolioDir = path.join(resolvedMemoryDir, "portfolio");
  const snapshotsDir = path.join(portfolioDir, "snapshots");
  const snapshotPath = path.join(snapshotsDir, `${tradingDate}.json`);
  const summaryPath = path.join(portfolioDir, "daily-summary.jsonl");

  // Full snapshot: capture the priced valuation alongside the raw account/positions so
  // the day is fully reproducible even if the live DB later mutates.
  const snapshotDocument = buildSnapshotDocument({
    tradingDate,
    generatedAt,
    account: input.account,
    valuation,
    summary,
    pricesAvailable: Boolean(input.prices && Object.keys(input.prices).length > 0),
  });
  // Overwrite-in-place for the same date: same filename => idempotent re-run.
  writer.write(snapshotPath, `${JSON.stringify(snapshotDocument, null, 2)}\n`);

  // Upsert the one-line summary keyed by tradingDate (no duplicates across re-runs).
  const nextSummaryFile = upsertSummaryLine(summaryPath, summary);
  writer.write(summaryPath, nextSummaryFile);

  return { summary, snapshotPath, summaryPath };
}

interface SnapshotDocumentInput {
  tradingDate: string;
  generatedAt: string;
  account: Account;
  valuation: PortfolioValuation;
  summary: DailySnapshotSummary;
  pricesAvailable: boolean;
}

function buildSnapshotDocument(input: SnapshotDocumentInput): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "daily-portfolio-snapshot",
    tradingDate: input.tradingDate,
    generatedAt: input.generatedAt,
    pricesAvailable: input.pricesAvailable,
    account: input.account,
    valuation: input.valuation,
    summary: input.summary,
  };
}

/**
 * Reads the existing JSONL (if any), drops any prior line for the same tradingDate, and
 * appends the fresh summary. Returns the full file body to be written atomically. Lines
 * that fail to parse or lack the matching key are preserved verbatim — we only ever
 * remove the one line we are replacing, never silently lose unrelated history.
 */
function upsertSummaryLine(summaryPath: string, summary: DailySnapshotSummary): string {
  const retained: string[] = [];

  if (existsSync(summaryPath)) {
    const existing = readFileSync(summaryPath, "utf8");
    for (const rawLine of existing.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      if (lineMatchesTradingDate(line, summary.tradingDate)) {
        continue; // drop the stale entry for this date
      }
      retained.push(line);
    }
  }

  retained.push(JSON.stringify(summary));
  return `${retained.join("\n")}\n`;
}

function lineMatchesTradingDate(line: string, tradingDate: string): boolean {
  try {
    const parsed = JSON.parse(line) as { tradingDate?: unknown };
    return parsed.tradingDate === tradingDate;
  } catch {
    // Unparseable line: leave it alone (treat as non-matching, so it is preserved).
    return false;
  }
}

function normalizeNow(now: string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }

  const parsed = new Date(now);

  if (Number.isNaN(parsed.getTime())) {
    throw new ArchiveDailySnapshotError(`Invalid timestamp: ${now}`);
  }

  return parsed.toISOString();
}

export class ArchiveDailySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveDailySnapshotError";
  }
}
