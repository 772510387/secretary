import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pruneOldArtifacts } from "../../src/app/prune-old-artifacts.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prune-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

function writeFileWithMtime(filePath: string, contents: string, mtimeMs: number): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  const seconds = mtimeMs / 1000;
  utimesSync(filePath, seconds, seconds);
}

const NOW = "2026-06-23T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pruneOldArtifacts", () => {
  it("removes old dated plan dirs and old cache files but keeps fresh ones and durable assets", () => {
    const memoryDir = makeTempDir();

    // Old plan dir (well past 30 days) and a fresh one.
    const oldPlanDir = path.join(memoryDir, "plans", "2026-01-01");
    const freshPlanDir = path.join(memoryDir, "plans", "2026-06-22");
    mkdirSync(oldPlanDir, { recursive: true });
    writeFileSync(path.join(oldPlanDir, "plan.json"), "{}");
    mkdirSync(freshPlanDir, { recursive: true });
    writeFileSync(path.join(freshPlanDir, "plan.json"), "{}");

    // Old cache file (by mtime) and a fresh cache file.
    const oldCache = path.join(memoryDir, "market", "cache", "old.json");
    const freshCache = path.join(memoryDir, "market", "cache", "fresh.json");
    writeFileWithMtime(oldCache, "{}", NOW_MS - 60 * DAY_MS);
    writeFileWithMtime(freshCache, "{}", NOW_MS - 1 * DAY_MS);

    // Durable assets that must never be touched.
    const ruleFile = path.join(memoryDir, "rules", "constitution.json");
    const longTermFile = path.join(memoryDir, "long_term", "lessons.json");
    const portfolioFile = path.join(memoryDir, "portfolio", "account.json");
    mkdirSync(path.dirname(ruleFile), { recursive: true });
    writeFileSync(ruleFile, "{}");
    mkdirSync(path.dirname(longTermFile), { recursive: true });
    writeFileSync(longTermFile, "{}");
    mkdirSync(path.dirname(portfolioFile), { recursive: true });
    writeFileSync(portfolioFile, "{}");

    const result = pruneOldArtifacts({ memoryDir, keepDays: 30, now: NOW });

    expect(result.dryRun).toBe(false);
    expect(result.keptDays).toBe(30);
    expect(result.removed.sort()).toEqual([oldCache, oldPlanDir].sort());

    // Old artifacts gone.
    expect(existsSync(oldPlanDir)).toBe(false);
    expect(existsSync(oldCache)).toBe(false);
    // Fresh artifacts kept.
    expect(existsSync(freshPlanDir)).toBe(true);
    expect(existsSync(freshCache)).toBe(true);
    // Durable assets untouched.
    expect(existsSync(ruleFile)).toBe(true);
    expect(existsSync(longTermFile)).toBe(true);
    expect(existsSync(portfolioFile)).toBe(true);
  });

  it("dryRun reports would-remove paths but deletes nothing", () => {
    const memoryDir = makeTempDir();
    const oldPlanDir = path.join(memoryDir, "plans", "2026-01-01");
    mkdirSync(oldPlanDir, { recursive: true });
    writeFileSync(path.join(oldPlanDir, "plan.json"), "{}");
    const oldCache = path.join(memoryDir, "market", "cache", "old.json");
    writeFileWithMtime(oldCache, "{}", NOW_MS - 60 * DAY_MS);

    const result = pruneOldArtifacts({ memoryDir, keepDays: 30, now: NOW, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.removed.sort()).toEqual([oldCache, oldPlanDir].sort());
    // Nothing actually deleted.
    expect(existsSync(oldPlanDir)).toBe(true);
    expect(existsSync(oldCache)).toBe(true);
  });

  it("defaults keepDays to 30", () => {
    const memoryDir = makeTempDir();
    const result = pruneOldArtifacts({ memoryDir, now: NOW });
    expect(result.keptDays).toBe(30);
    expect(result.removed).toEqual([]);
  });

  it("does not throw and returns empty when target dirs are missing", () => {
    const memoryDir = makeTempDir(); // empty: no plans/, no market/cache/
    const result = pruneOldArtifacts({ memoryDir, now: NOW });
    expect(result.removed).toEqual([]);
  });

  it("ignores non-date-named entries under plans/", () => {
    const memoryDir = makeTempDir();
    const notADate = path.join(memoryDir, "plans", "README");
    mkdirSync(notADate, { recursive: true });
    writeFileSync(path.join(notADate, "x"), "");

    const result = pruneOldArtifacts({ memoryDir, keepDays: 30, now: NOW });
    expect(result.removed).toEqual([]);
    expect(existsSync(notADate)).toBe(true);
  });
});
