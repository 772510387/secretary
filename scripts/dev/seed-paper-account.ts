import { loadConfig } from "../../src/config/index.js";
import {
  PaperAccountInitializationError,
  buildInitialPaperAccountSeed,
} from "../../src/app/index.js";
import {
  StorageError,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";

interface CliOptions {
  write: boolean;
  dryRun: boolean;
  reset: boolean;
  accountId?: string;
  initialCash?: number;
  at?: string;
}

try {
  const cli = parseArgs(process.argv.slice(2));

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig();
  const seed = buildInitialPaperAccountSeed({
    accountId: cli.accountId,
    initialCash: cli.initialCash ?? config.trading.initialCash,
    now: cli.at,
  });
  const result = initializePaperAccountMemory({
    memoryDir: config.storage.memoryDir,
    seed,
    reset: cli.reset,
    dryRun: cli.dryRun,
  });

  console.log(
    JSON.stringify(
      {
        status: "ok",
        action: result.dryRun ? "dry-run" : "write",
        accountId: seed.account.accountId,
        initialCash: seed.account.initialCash,
        reset: result.reset,
        existingFiles: result.existingFiles,
        plannedWrites: result.plannedWrites,
        writtenFiles: result.writtenFiles,
        backupFiles: result.backupFiles,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (error instanceof PaperAccountInitializationError || error instanceof StorageError) {
    console.error(error.message);
    process.exit(1);
  }

  throw error;
}

function parseArgs(args: string[]): CliOptions & { help: boolean } {
  const options: CliOptions & { help: boolean } = {
    write: false,
    dryRun: true,
    reset: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--write":
        options.write = true;
        options.dryRun = false;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--reset":
        options.reset = true;
        break;
      case "--account-id":
        options.accountId = readValue(args, index, arg);
        index += 1;
        break;
      case "--initial-cash":
        options.initialCash = parsePositiveNumber(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--at":
        options.at = readValue(args, index, arg);
        index += 1;
        break;
      default:
        throw new PaperAccountInitializationError(`Unknown argument: ${arg}`);
    }
  }

  if (options.write && options.dryRun) {
    throw new PaperAccountInitializationError("Use either --write or --dry-run, not both.");
  }

  return options;
}

function readValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new PaperAccountInitializationError(`Missing value for ${name}`);
  }

  return value;
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PaperAccountInitializationError(`${name} must be a positive number`);
  }

  return parsed;
}

function printHelp(): void {
  console.log(`seed-paper-account

Usage:
  npm run seed:paper
  npm run seed:paper -- --write
  npm run seed:paper -- --write --reset

Options:
  --dry-run              Print planned writes without changing files. Default.
  --write                Write memory/portfolio files.
  --reset                Allow overwriting existing account/positions/trades files.
  --account-id <id>      Account id. Default: paper-main.
  --initial-cash <num>   Initial cash. Default: config trading.initialCash.
  --at <iso>             Fixed initialization timestamp.
`);
}

