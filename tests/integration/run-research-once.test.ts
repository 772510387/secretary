import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunResearchOnceError,
  runResearchOnce,
  type ResearchRunner,
} from "../../src/app/index.js";
import {
  researchReportSchema,
  researchTaskSchema,
  type ResearchReport,
  type ResearchTask,
} from "../../src/domain/research/index.js";
import {
  ResearchMemoryStore,
  createResearchMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const generatedAt = "2026-06-12T08:30:00.000Z";
const tradingDate = "2026-06-12";

describe("runResearchOnce", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("returns a mock ResearchReport without writing by default", async () => {
    const writer = {
      writeReport: vi.fn(),
    };

    const result = await runResearchOnce({
      task: makeTask(),
      writer,
      now: generatedAt,
      idGenerator: createIdGenerator(),
    });

    expect(result.mode).toBe("return_only");
    expect(result.write).toBeUndefined();
    expect(writer.writeReport).not.toHaveBeenCalled();
    expect(result.report).toMatchObject({
      provider: "mock",
      taskId: "research-task-000636",
      symbol: "000636",
      market: "SZSE",
      tradingDate,
      generatedAt,
      conclusion: "neutral",
      confidence: 0.5,
      requiresHumanReview: true,
      degraded: false,
      tradeIntentDrafts: [],
      metadata: {
        source: "mock",
        liveTrading: false,
        directExecutionAllowed: false,
        brokerConnected: false,
        accountWriteAllowed: false,
      },
    });
    expect(result.report.summary).toContain("No real external research system");
  });

  it("builds a ResearchTask from basic parameters", async () => {
    const result = await runResearchOnce({
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
      objective: "Generate one safe mock research report.",
      context: {
        latestPrice: 10.5,
      },
      now: generatedAt,
      idGenerator: createIdGenerator(),
    });

    expect(result.task).toMatchObject({
      taskId: "research-task-000636-2026-06-12",
      symbol: "000636",
      market: "SZSE",
      name: "Fenghua Hi-Tech",
      tradingDate,
      objective: "Generate one safe mock research report.",
      context: {
        latestPrice: 10.5,
      },
      createdAt: generatedAt,
    });
    expect(result.report.taskId).toBe(result.task.taskId);
  });

  it("writes the report into memory/research and creates metadata-only audit", async () => {
    const memoryDir = createTempMemoryDir();
    const writer = new ResearchMemoryStore({
      memoryDir,
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
    });

    const result = await runResearchOnce({
      task: makeTask(),
      writer,
      writeToMemory: true,
      now: generatedAt,
      idGenerator: createIdGenerator(),
    });
    const paths = createResearchMemoryPaths(
      memoryDir,
      result.report.tradingDate,
      result.report.reportId,
      generatedAt,
    );
    const stored = researchReportSchema.parse(JSON.parse(readFileSync(paths.reportPath, "utf8")));
    const auditEvents = readJsonLines(paths.auditLogPath);

    expect(result.mode).toBe("memory_write");
    expect(result.write).toMatchObject({
      filePath: paths.reportPath,
      auditLogPath: paths.auditLogPath,
    });
    expect(existsSync(paths.reportPath)).toBe(true);
    expect(existsSync(paths.auditLogPath)).toBe(true);
    expect(stored.reportId).toBe(result.report.reportId);
    expect(stored.provider).toBe("mock");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "write",
      subject: {
        type: "report",
        id: result.report.reportId,
      },
      result: "success",
      correlationId: result.report.taskId,
      metadata: {
        reportId: result.report.reportId,
        taskId: result.report.taskId,
        provider: "mock",
        symbol: "000636",
        market: "SZSE",
        tradingDate,
        degraded: false,
        tradeIntentDraftCount: 0,
        requiresHumanReview: true,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain(result.report.summary);
    expect(existsSync(path.join(memoryDir, "portfolio"))).toBe(false);
  });

  it("requires a writer when writeToMemory is enabled", async () => {
    await expect(
      runResearchOnce({
        task: makeTask(),
        writeToMemory: true,
        now: generatedAt,
      }),
    ).rejects.toThrow(RunResearchOnceError);
  });

  it("rejects injected reports with execution fields before writing", async () => {
    const writer = {
      writeReport: vi.fn(),
    };
    const runner: ResearchRunner = {
      async runResearch(task: ResearchTask) {
        return {
          ...makeReport(task),
          orders: [{ orderId: "must-not-write" }],
          execution: { status: "forbidden" },
        } as unknown as ResearchReport;
      },
    };

    await expect(
      runResearchOnce({
        task: makeTask(),
        runner,
        writer,
        writeToMemory: true,
        now: generatedAt,
      }),
    ).rejects.toThrow();

    expect(writer.writeReport).not.toHaveBeenCalled();
  });
});

function makeTask() {
  return researchTaskSchema.parse({
    taskId: "research-task-000636",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    tradingDate,
    objective: "Summarize stock research into a safe ResearchReport.",
    context: {
      latestPrice: 10.5,
    },
    createdAt: generatedAt,
  });
}

function makeReport(task: ResearchTask): ResearchReport {
  return researchReportSchema.parse({
    reportId: "research-000636-2026-06-12-injected",
    taskId: task.taskId,
    provider: "manual",
    symbol: task.symbol,
    market: task.market,
    name: task.name,
    tradingDate: task.tradingDate,
    generatedAt,
    title: "Injected research report",
    summary: "Injected report that should still be schema-checked by the app use case.",
    conclusion: "neutral",
    confidence: 0.5,
    findings: [
      {
        findingId: "finding-injected",
        category: "other",
        statement: "Injected runner report.",
        evidence: [],
        confidence: 0.5,
      },
    ],
    bullBearViews: [],
    riskFactors: [],
    sources: [],
    tradeIntentDrafts: [],
    requiresHumanReview: true,
    degraded: false,
    metadata: {
      source: "test",
    },
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-run-research-once-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return String(id).padStart(4, "0");
  };
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
