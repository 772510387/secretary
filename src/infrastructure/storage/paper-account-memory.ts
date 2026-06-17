import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertCanInitializePaperAccount,
  type PaperAccountSeed,
} from "../../app/index.js";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../domain/portfolio/index.js";
import { appendAuditEvent } from "../logging/index.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

const positionsSchema = z.array(positionSchema);

export interface PortfolioMemoryPaths {
  portfolioDir: string;
  logsDir: string;
  accountPath: string;
  positionsPath: string;
  tradesPath: string;
  ordersPath: string;
  auditLogPath: string;
}

export interface InitializePaperAccountMemoryOptions {
  memoryDir: string;
  seed: PaperAccountSeed;
  reset?: boolean;
  dryRun?: boolean;
  writer?: AtomicFileWriter;
}

export interface InitializePaperAccountMemoryResult {
  dryRun: boolean;
  reset: boolean;
  paths: PortfolioMemoryPaths;
  existingFiles: string[];
  plannedWrites: string[];
  writtenFiles: string[];
  backupFiles: string[];
}

export function createPortfolioMemoryPaths(
  memoryDir: string,
  occurredAt: string = new Date().toISOString(),
): PortfolioMemoryPaths {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const portfolioDir = path.join(resolvedMemoryDir, "portfolio");
  const logsDir = path.join(resolvedMemoryDir, "logs");
  const date = occurredAt.slice(0, 10);

  return {
    portfolioDir,
    logsDir,
    accountPath: path.join(portfolioDir, "account.json"),
    positionsPath: path.join(portfolioDir, "positions.json"),
    tradesPath: path.join(portfolioDir, "trades.jsonl"),
    ordersPath: path.join(portfolioDir, "orders.jsonl"),
    auditLogPath: path.join(logsDir, `audit-${date}.jsonl`),
  };
}

export function initializePaperAccountMemory(
  options: InitializePaperAccountMemoryOptions,
): InitializePaperAccountMemoryResult {
  const dryRun = options.dryRun !== false;
  const reset = options.reset === true;
  const writer = options.writer ?? new AtomicFileWriter();
  const paths = createPortfolioMemoryPaths(
    options.memoryDir,
    options.seed.auditEvent.occurredAt,
  );
  const existingState = {
    account: existsSync(paths.accountPath),
    positions: existsSync(paths.positionsPath),
    trades: existsSync(paths.tradesPath),
  };
  const existingFiles = existingFileNames(existingState, paths);
  const plannedWrites = [
    paths.accountPath,
    paths.positionsPath,
    paths.tradesPath,
    paths.auditLogPath,
  ];

  if (dryRun) {
    return {
      dryRun,
      reset,
      paths,
      existingFiles,
      plannedWrites,
      writtenFiles: [],
      backupFiles: [],
    };
  }

  assertCanInitializePaperAccount(existingState, { reset });

  const accountStore = new JsonStore<Account>({
    filePath: paths.accountPath,
    schema: accountSchema,
    writer,
  });
  const positionsStore = new JsonStore<Position[]>({
    filePath: paths.positionsPath,
    schema: positionsSchema,
    writer,
  });

  const accountWrite = accountStore.write(options.seed.account);
  const positionsWrite = positionsStore.write(options.seed.positions);
  const tradesWrite = writer.write(paths.tradesPath, options.seed.tradesJsonl);
  const auditWrite = appendAuditEvent(
    paths.auditLogPath,
    buildAuditEvent(paths, options.seed, reset),
    writer,
  );

  return {
    dryRun,
    reset,
    paths,
    existingFiles,
    plannedWrites,
    writtenFiles: [
      accountWrite.filePath,
      positionsWrite.filePath,
      tradesWrite.filePath,
      auditWrite.filePath,
    ],
    backupFiles: [
      accountWrite.backupPath,
      positionsWrite.backupPath,
      tradesWrite.backupPath,
      auditWrite.backupPath,
    ].filter((value): value is string => Boolean(value)),
  };
}

function buildAuditEvent(
  paths: PortfolioMemoryPaths,
  seed: PaperAccountSeed,
  reset: boolean,
): AuditEvent {
  return auditEventSchema.parse({
    ...seed.auditEvent,
    metadata: {
      ...seed.auditEvent.metadata,
      reset,
      accountPath: path.normalize(paths.accountPath),
      positionsPath: path.normalize(paths.positionsPath),
      tradesPath: path.normalize(paths.tradesPath),
      ordersPath: path.normalize(paths.ordersPath),
    },
  });
}

function existingFileNames(
  existingState: { account: boolean; positions: boolean; trades: boolean },
  paths: PortfolioMemoryPaths,
): string[] {
  return [
    existingState.account ? paths.accountPath : undefined,
    existingState.positions ? paths.positionsPath : undefined,
    existingState.trades ? paths.tradesPath : undefined,
  ].filter((value): value is string => Boolean(value));
}
