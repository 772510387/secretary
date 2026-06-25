import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface PruneOldArtifactsInput {
  memoryDir: string;
  /** Retention window in days; artifacts older than this are eligible. Default 30. */
  keepDays?: number;
  /** ISO timestamp used as "today"; accepted for determinism in tests. */
  now?: string;
  /** When true, compute and return what WOULD be removed without deleting anything. */
  dryRun?: boolean;
}

export interface PruneOldArtifactsResult {
  /** Absolute paths that were removed (or, in dryRun, would be removed). */
  removed: string[];
  keptDays: number;
  dryRun: boolean;
}

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 数据库清洗 (CONSERVATIVE): prune only clearly-ephemeral, dated artifacts past the
 * retention window. Deliberately narrow — it touches exactly two locations:
 *
 *  1. `<memoryDir>/plans/<YYYY-MM-DD>/` directories whose DATE (parsed from the dir name,
 *     not mtime) is older than (now - keepDays). Dir-name dating is intentional: a plan
 *     folder's identity is its trading date, and mtime drifts on copy/restore.
 *  2. Files directly under `<memoryDir>/market/cache/` whose mtime is older than the
 *     window. Cache is regenerable, so mtime is the right signal there.
 *
 * It NEVER touches rules/, long_term/, portfolio/ (account/positions/snapshots),
 * proposals/, reviews/, history/, or logs/audit — the durable record. A missing target
 * directory is not an error; it simply contributes nothing to the result.
 *
 * Pure/offline filesystem maintenance: no model, no network.
 */
export function pruneOldArtifacts(
  input: PruneOldArtifactsInput,
): PruneOldArtifactsResult {
  const dryRun = input.dryRun === true;
  const keptDays = input.keepDays ?? 30;
  const nowMs = normalizeNowMs(input.now);
  const cutoffMs = nowMs - keptDays * MS_PER_DAY;

  const resolvedMemoryDir = path.resolve(input.memoryDir);
  const removed: string[] = [];

  pruneDatedPlanDirs({
    plansDir: path.join(resolvedMemoryDir, "plans"),
    cutoffMs,
    dryRun,
    removed,
  });

  pruneCacheFilesByMtime({
    cacheDir: path.join(resolvedMemoryDir, "market", "cache"),
    cutoffMs,
    dryRun,
    removed,
  });

  return { removed, keptDays, dryRun };
}

interface PruneDatedPlanDirsInput {
  plansDir: string;
  cutoffMs: number;
  dryRun: boolean;
  removed: string[];
}

function pruneDatedPlanDirs(input: PruneDatedPlanDirsInput): void {
  if (!existsSync(input.plansDir)) {
    return; // nothing to do; missing dir is not an error
  }

  for (const entry of readdirSync(input.plansDir, { withFileTypes: true })) {
    // Only date-named subdirectories are ephemeral plan folders; ignore everything else.
    if (!entry.isDirectory() || !DATE_DIR_PATTERN.test(entry.name)) {
      continue;
    }

    const dirDateMs = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(dirDateMs) || dirDateMs >= input.cutoffMs) {
      continue; // within retention (or unparseable) -> keep
    }

    const target = path.join(input.plansDir, entry.name);
    input.removed.push(target);
    if (!input.dryRun) {
      rmSync(target, { recursive: true, force: true });
    }
  }
}

interface PruneCacheFilesInput {
  cacheDir: string;
  cutoffMs: number;
  dryRun: boolean;
  removed: string[];
}

function pruneCacheFilesByMtime(input: PruneCacheFilesInput): void {
  if (!existsSync(input.cacheDir)) {
    return; // nothing to do; missing dir is not an error
  }

  for (const entry of readdirSync(input.cacheDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue; // only flat cache files; never recurse into subdirs here
    }

    const target = path.join(input.cacheDir, entry.name);
    const mtimeMs = statSync(target).mtimeMs;
    if (mtimeMs >= input.cutoffMs) {
      continue; // fresh enough -> keep
    }

    input.removed.push(target);
    if (!input.dryRun) {
      rmSync(target, { force: true });
    }
  }
}

function normalizeNowMs(now: string | undefined): number {
  if (now === undefined) {
    return Date.now();
  }

  const parsed = Date.parse(now);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${now}`);
  }

  return parsed;
}
