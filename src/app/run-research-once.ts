import type { z } from "zod";
import {
  researchReportSchema,
  researchTaskSchema,
  validateResearchReport,
  validateResearchTask,
  type ResearchReport,
  type ResearchTask,
} from "../domain/research/index.js";
import type { JsonValue } from "../domain/shared/index.js";

export interface ResearchRunner {
  runResearch(task: ResearchTask): Promise<unknown>;
}

export interface ResearchOnceWriteResult {
  filePath: string;
  backupPath?: string;
  auditLogPath?: string;
  auditBackupPath?: string;
}

export interface ResearchReportWriter {
  writeReport(report: ResearchReport): ResearchOnceWriteResult;
}

export interface RunResearchOnceInput {
  task?: ResearchTaskInput;
  taskId?: string;
  symbol?: string;
  market?: ResearchTask["market"];
  name?: string;
  tradingDate?: string;
  objective?: string;
  context?: JsonValue;
  createdAt?: Date | string;
  runner?: ResearchRunner;
  writer?: ResearchReportWriter;
  writeToMemory?: boolean;
  now?: Date | string;
  idGenerator?: () => string;
  metadata?: Record<string, unknown>;
}

export interface RunResearchOnceResult {
  mode: "return_only" | "memory_write";
  task: ResearchTask;
  report: ResearchReport;
  write?: ResearchOnceWriteResult;
}

export interface MockResearchRunnerOptions {
  now?: () => Date;
  idGenerator?: () => string;
  metadata?: Record<string, unknown>;
}

export type ResearchTaskInput = z.input<typeof researchTaskSchema>;

export async function runResearchOnce(
  input: RunResearchOnceInput,
): Promise<RunResearchOnceResult> {
  const now = normalizeDate(input.now, "research run date");
  const task = resolveResearchTask(input, now);
  const runner = input.runner ?? createMockResearchRunner({
    now: () => now,
    idGenerator: input.idGenerator,
    metadata: input.metadata,
  });
  const report = hardenResearchReport(await runner.runResearch(task));

  if (!input.writeToMemory) {
    return {
      mode: "return_only",
      task,
      report,
    };
  }

  if (!input.writer) {
    throw new RunResearchOnceError("writeToMemory requires a ResearchReportWriter");
  }

  return {
    mode: "memory_write",
    task,
    report,
    write: input.writer.writeReport(report),
  };
}

export function createMockResearchRunner(
  options: MockResearchRunnerOptions = {},
): ResearchRunner {
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? defaultIdGenerator;

  return {
    async runResearch(taskInput: ResearchTask): Promise<ResearchReport> {
      const task = validateResearchTask(taskInput);
      const generatedAt = normalizeDate(now(), "mock research generation date").toISOString();
      const stockName = task.name ? `${task.symbol} ${task.name}` : task.symbol;

      return researchReportSchema.parse({
        reportId: `research-${task.symbol}-${task.tradingDate}-${safeIdentifier(idGenerator())}`,
        taskId: task.taskId,
        provider: "mock",
        symbol: task.symbol,
        market: task.market,
        name: task.name,
        tradingDate: task.tradingDate,
        generatedAt,
        title: `${task.tradingDate} ${stockName} Mock Research`,
        summary: [
          `Mock research for ${stockName}.`,
          `Objective: ${limitText(task.objective, 300)}`,
          "No real external research system, broker, or account writer was used.",
        ].join(" "),
        conclusion: "neutral",
        confidence: 0.5,
        findings: [
          {
            findingId: `finding-${safeIdentifier(idGenerator())}`,
            category: "other",
            statement: "Mock runner produced a neutral placeholder for manual review.",
            evidence: ["Generated without external systems or execution access."],
            confidence: 0.5,
          },
        ],
        bullBearViews: [
          {
            side: "neutral",
            thesis: "The mock runner does not infer a directional trading edge.",
            evidence: ["Use a real research adapter only after explicit wiring and review."],
            confidence: 0.5,
          },
        ],
        riskFactors: [
          {
            riskId: `risk-${safeIdentifier(idGenerator())}`,
            severity: "info",
            description: "This is a mock research report and must not be used as an order signal.",
            mitigation: "Run manual review before creating any trade intent draft.",
          },
        ],
        sources: [
          {
            sourceId: `source-${safeIdentifier(idGenerator())}`,
            sourceType: "system",
            title: "runResearchOnce mock runner",
            observedAt: generatedAt,
            note: "Local deterministic mock; no network request was made.",
          },
        ],
        tradeIntentDrafts: [],
        requiresHumanReview: true,
        degraded: false,
        metadata: safetyMetadata({
          ...options.metadata,
          source: "mock",
          runner: "createMockResearchRunner",
        }),
      });
    },
  };
}

function resolveResearchTask(input: RunResearchOnceInput, now: Date): ResearchTask {
  if (input.task) {
    return validateResearchTask(input.task);
  }

  if (!input.symbol || !input.market || !input.objective) {
    throw new RunResearchOnceError(
      "runResearchOnce requires either task or symbol, market, and objective",
    );
  }

  const tradingDate = input.tradingDate ?? formatTradeDate(now);
  const createdAt = input.createdAt === undefined
    ? now.toISOString()
    : normalizeDate(input.createdAt, "research task createdAt").toISOString();

  return validateResearchTask({
    taskId: input.taskId ?? `research-task-${input.symbol}-${tradingDate}`,
    symbol: input.symbol,
    market: input.market,
    name: input.name,
    tradingDate,
    objective: input.objective,
    context: input.context ?? {},
    createdAt,
  });
}

function hardenResearchReport(input: unknown): ResearchReport {
  const report = validateResearchReport(input);

  return researchReportSchema.parse({
    ...report,
    metadata: safetyMetadata(asRecord(report.metadata)),
  });
}

function safetyMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    liveTrading: false,
    directExecutionAllowed: false,
    brokerConnected: false,
    accountWriteAllowed: false,
  };
}

function normalizeDate(value: Date | string | undefined, label: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RunResearchOnceError(`Invalid ${label}`);
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new RunResearchOnceError(`Invalid ${label}: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function formatTradeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultIdGenerator(): string {
  return globalThis.crypto.randomUUID();
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 64);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "id";
}

function limitText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function asRecord(value: JsonValue): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

export class RunResearchOnceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunResearchOnceError";
  }
}
