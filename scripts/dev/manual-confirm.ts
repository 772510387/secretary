import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  createApprovalRecord,
} from "../../src/domain/memory/index.js";
import {
  ApprovalRecordStore,
  ApprovalRecordStoreError,
} from "../../src/infrastructure/storage/index.js";

export type ManualConfirmCliOptions =
  | {
    help: true;
  }
  | {
    help: false;
    command: "list";
    memoryDir?: string;
  }
  | {
    help: false;
    command: "approve" | "reject";
    proposalId: string;
    approvalId?: string;
    reviewerId: string;
    operatorSessionId: string;
    riskSnapshotRef: string;
    note?: string;
    at?: string;
    memoryDir?: string;
  };

interface PartialManualConfirmCliOptions {
  help: boolean;
  command?: "list" | "approve" | "reject";
  proposalId?: string;
  approvalId?: string;
  reviewerId?: string;
  operatorSessionId?: string;
  riskSnapshotRef?: string;
  note?: string;
  at?: string;
  memoryDir?: string;
}

export async function main(args: string[]): Promise<void> {
  const cli = parseManualConfirmArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  const config = cli.memoryDir ? undefined : loadConfig();
  const memoryDir = cli.memoryDir ?? config!.storage.memoryDir;
  const runAt = "at" in cli && cli.at ? cli.at : new Date().toISOString();
  const store = new ApprovalRecordStore({
    memoryDir,
    now: () => new Date(runAt),
  });

  if (cli.command === "list") {
    const proposals = store.listProposals({ status: "pending_review" });

    console.log(
      JSON.stringify(
        {
          status: "ok",
          command: "list",
          count: proposals.length,
          proposals: proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            proposalType: proposal.proposalType,
            status: proposal.status,
            createdAt: proposal.createdAt,
            symbol: proposal.proposalType === "trade_intent_review" ? proposal.symbol : undefined,
            market: proposal.proposalType === "trade_intent_review" ? proposal.market : undefined,
          })),
          brokerHandoffTriggered: false,
          brokerConnected: false,
          liveTrading: false,
        },
        null,
        2,
      ),
    );
    return;
  }

  const approval = createApprovalRecord({
    approvalId: cli.approvalId ?? `approval-${cli.proposalId}`,
    proposalId: cli.proposalId,
    decision: cli.command === "approve" ? "approved" : "rejected",
    reviewer: {
      type: "user",
      id: cli.reviewerId,
    },
    reviewedAt: runAt,
    operatorSessionId: cli.operatorSessionId,
    riskSnapshotRef: cli.riskSnapshotRef,
    reviewNote: cli.note,
    metadata: {
      source: "scripts/dev/manual-confirm.ts",
      brokerHandoffTriggered: false,
      brokerConnected: false,
      liveTrading: false,
    },
  });
  const result = store.reviewProposalWithApproval(approval);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        command: cli.command,
        proposalId: result.proposal.proposalId,
        proposalStatus: result.proposal.status,
        approvalId: result.approval.approvalId,
        approvalPath: result.approvalWrite.filePath,
        proposalPath: result.proposalWrite.filePath,
        auditLogPath: result.approvalWrite.auditLogPath,
        brokerHandoffTriggered: false,
        brokerConnected: false,
        liveTrading: false,
      },
      null,
      2,
    ),
  );
}

export function parseManualConfirmArgs(args: string[]): ManualConfirmCliOptions {
  const options: PartialManualConfirmCliOptions = {
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (index === 0 && (arg === "list" || arg === "approve" || arg === "reject")) {
      options.command = arg;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--proposal-id":
        options.proposalId = parseIdentifier(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--approval-id":
        options.approvalId = parseIdentifier(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--reviewer-id":
        options.reviewerId = parseIdentifier(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--operator-session-id":
        options.operatorSessionId = parseIdentifier(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--risk-snapshot-ref":
        options.riskSnapshotRef = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--note":
        options.note = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--at":
        options.at = parseDateTime(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--memory-dir":
        options.memoryDir = parseNonEmpty(readValue(args, index, arg), arg);
        index += 1;
        break;
      default:
        throw new ManualConfirmCliError(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) {
    return {
      help: true,
    };
  }

  if (!options.command) {
    throw new ManualConfirmCliError("Missing command: list, approve, or reject");
  }

  if (options.command === "list") {
    return {
      help: false,
      command: "list",
      memoryDir: options.memoryDir,
    };
  }

  const missing = [
    ["--proposal-id", options.proposalId],
    ["--reviewer-id", options.reviewerId],
    ["--operator-session-id", options.operatorSessionId],
    ["--risk-snapshot-ref", options.riskSnapshotRef],
  ]
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new ManualConfirmCliError(`Missing required argument(s): ${missing.join(", ")}`);
  }

  return {
    help: false,
    command: options.command,
    proposalId: options.proposalId!,
    approvalId: options.approvalId,
    reviewerId: options.reviewerId!,
    operatorSessionId: options.operatorSessionId!,
    riskSnapshotRef: options.riskSnapshotRef!,
    note: options.note,
    at: options.at,
    memoryDir: options.memoryDir,
  };
}

function readValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new ManualConfirmCliError(`Missing value for ${name}`);
  }

  return value;
}

function parseIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new ManualConfirmCliError(`${name} must be a valid identifier`);
  }

  return value;
}

function parseDateTime(value: string, name: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    throw new ManualConfirmCliError(`${name} must be a valid date or datetime`);
  }

  return parsed.toISOString();
}

function parseNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new ManualConfirmCliError(`${name} must not be empty`);
  }

  return trimmed;
}

function printHelp(): void {
  console.log(`manual-confirm

Usage:
  npm run manual-confirm:dev -- list --memory-dir memory
  npm run manual-confirm:dev -- approve --proposal-id proposal-001 --reviewer-id operator-001 --operator-session-id session-001 --risk-snapshot-ref risk/run-001
  npm run manual-confirm:dev -- reject --proposal-id proposal-001 --reviewer-id operator-001 --operator-session-id session-001 --risk-snapshot-ref risk/run-001 --note "Not today"

This development CLI only records ApprovalRecord and updates proposal review status. It never calls ManualConfirmBroker handoff, PaperBroker, live broker, real LLM, or external network.
`);
}

export class ManualConfirmCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualConfirmCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (
      error instanceof ManualConfirmCliError ||
      error instanceof ApprovalRecordStoreError ||
      error instanceof ConfigLoadError
    ) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
