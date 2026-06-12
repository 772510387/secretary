import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaperAccountInitializationError,
  buildInitialPaperAccountSeed,
} from "../../src/app/index.js";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import {
  createPortfolioMemoryPaths,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";
import { z } from "zod";

const tempRoots: string[] = [];
const fixedNow = "2026-06-12T01:30:00.000Z";

describe("paper account initialization", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("dry-runs planned writes without creating files", () => {
    const memoryDir = createTempMemoryDir();
    const seed = buildInitialPaperAccountSeed({ now: fixedNow });
    const result = initializePaperAccountMemory({ memoryDir, seed });

    expect(result.dryRun).toBe(true);
    expect(result.writtenFiles).toEqual([]);
    expect(result.plannedWrites).toHaveLength(4);
    expect(existsSync(result.paths.accountPath)).toBe(false);
    expect(existsSync(result.paths.positionsPath)).toBe(false);
    expect(existsSync(result.paths.tradesPath)).toBe(false);
    expect(existsSync(result.paths.auditLogPath)).toBe(false);
  });

  it("writes account, empty positions, empty trades, and audit log", () => {
    const memoryDir = createTempMemoryDir();
    const seed = buildInitialPaperAccountSeed({ now: fixedNow, initialCash: 20000 });
    const result = initializePaperAccountMemory({ memoryDir, seed, dryRun: false });

    expect(result.writtenFiles).toEqual([
      result.paths.accountPath,
      result.paths.positionsPath,
      result.paths.tradesPath,
      result.paths.auditLogPath,
    ]);
    expect(result.backupFiles).toEqual([]);

    const account = accountSchema.parse(readJson(result.paths.accountPath));
    expect(account.initialCash).toBe(20000);
    expect(account.cash.available).toBe(20000);
    expect(account.cash.frozen).toBe(0);
    expect(account.type).toBe("paper");

    const positions = z.array(positionSchema).parse(readJson(result.paths.positionsPath));
    expect(positions).toEqual([]);
    expect(readFileSync(result.paths.tradesPath, "utf8")).toBe("");

    const auditLines = readFileSync(result.paths.auditLogPath, "utf8")
      .trim()
      .split(/\r?\n/);
    expect(auditLines).toHaveLength(1);
    expect(auditEventSchema.parse(JSON.parse(auditLines[0]!)).subject).toEqual({
      type: "account",
      id: "paper-main",
    });
  });

  it("rejects repeated initialization unless reset is explicit", () => {
    const memoryDir = createTempMemoryDir();
    const seed = buildInitialPaperAccountSeed({ now: fixedNow });

    initializePaperAccountMemory({ memoryDir, seed, dryRun: false });

    expect(() => initializePaperAccountMemory({ memoryDir, seed, dryRun: false })).toThrow(
      PaperAccountInitializationError,
    );
    expect(() => initializePaperAccountMemory({ memoryDir, seed, dryRun: false })).toThrow(
      /Pass --reset/,
    );
  });

  it("allows dry-run after initialization and reports existing files", () => {
    const memoryDir = createTempMemoryDir();
    const seed = buildInitialPaperAccountSeed({ now: fixedNow });

    initializePaperAccountMemory({ memoryDir, seed, dryRun: false });
    const result = initializePaperAccountMemory({ memoryDir, seed });

    expect(result.dryRun).toBe(true);
    expect(result.writtenFiles).toEqual([]);
    expect(result.existingFiles).toEqual([
      result.paths.accountPath,
      result.paths.positionsPath,
      result.paths.tradesPath,
    ]);
  });

  it("overwrites with reset and creates backups", () => {
    const memoryDir = createTempMemoryDir();
    const seed = buildInitialPaperAccountSeed({ now: fixedNow, initialCash: 20000 });

    initializePaperAccountMemory({ memoryDir, seed, dryRun: false });

    const resetSeed = buildInitialPaperAccountSeed({
      now: "2026-06-12T02:00:00.000Z",
      initialCash: 30000,
    });
    const result = initializePaperAccountMemory({
      memoryDir,
      seed: resetSeed,
      dryRun: false,
      reset: true,
    });

    expect(result.backupFiles.length).toBeGreaterThanOrEqual(4);
    expect(result.backupFiles.every((filePath) => existsSync(filePath))).toBe(true);
    expect(accountSchema.parse(readJson(result.paths.accountPath)).initialCash).toBe(30000);

    const portfolioBackups = readdirSync(path.join(result.paths.portfolioDir, ".backups"));
    expect(portfolioBackups.some((file) => file.startsWith("account.json."))).toBe(true);
    expect(portfolioBackups.some((file) => file.startsWith("positions.json."))).toBe(true);
    expect(portfolioBackups.some((file) => file.startsWith("trades.jsonl."))).toBe(true);
  });

  it("uses deterministic memory paths", () => {
    const memoryDir = createTempMemoryDir();
    const paths = createPortfolioMemoryPaths(memoryDir, fixedNow);

    expect(paths.accountPath).toBe(path.join(memoryDir, "portfolio", "account.json"));
    expect(paths.positionsPath).toBe(path.join(memoryDir, "portfolio", "positions.json"));
    expect(paths.tradesPath).toBe(path.join(memoryDir, "portfolio", "trades.jsonl"));
    expect(paths.auditLogPath).toBe(path.join(memoryDir, "logs", "audit-2026-06-12.jsonl"));
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-paper-account-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}
