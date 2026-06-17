import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateReport,
  generatedReportSchema,
  runMarketSentinelOnce,
  runResearchOnce,
} from "../../src/app/index.js";
import type {
  CerebellumEvent,
} from "../../src/domain/cerebellum/index.js";
import { quoteSnapshotSchema } from "../../src/domain/market/index.js";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import {
  researchReportSchema,
  researchTaskSchema,
} from "../../src/domain/research/index.js";
import {
  MockBrainProvider,
  TradingAgentsCnAdapter,
} from "../../src/infrastructure/providers/index.js";
import type { SchedulerTaskContext } from "../../src/infrastructure/scheduler/index.js";
import {
  ReportsMemoryStore,
  ResearchMemoryStore,
  createReportsMemoryPaths,
  createResearchMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import { createSchedulerRuntime } from "../../src/runtime/index.js";

const tempRoots: string[] = [];
const inSession = new Date("2026-06-12T01:31:00.000Z");
const outsideSession = new Date("2026-06-12T03:45:00.000Z");

describe("scheduler paper research loop callback", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("triggers one mock paper research loop callback during trading session", async () => {
    const memoryDir = createTempMemoryDir();
    const runtime = createSchedulerRuntime({
      clock: {
        now: () => inSession,
      },
    });
    const loopResults: MockLoopResult[] = [];
    const runner = runtime.createMarketSentinelRunner({
      jobId: "paper-research-loop",
      task: async (context) => {
        loopResults.push(await runMockPaperResearchLoop(context, memoryDir));
      },
    });

    const skipped = await runner.triggerOnce(outsideSession);
    const run = await runner.triggerOnce(inSession);

    expect(skipped.status).toBe("skipped_outside_session");
    expect(run).toMatchObject({
      jobId: "paper-research-loop",
      status: "completed",
      scheduledAt: inSession.toISOString(),
    });
    expect(loopResults).toHaveLength(1);
    expect(loopResults[0]).toMatchObject({
      jobId: "paper-research-loop",
      beijingDate: "2026-06-12",
      eventType: "position_stop_loss",
      provider: "trading_agents_cn",
      brainProvider: "mock",
      tradeIntentExecutable: false,
      reportRecommendationExecutable: false,
    });

    const result = loopResults[0]!;
    const storedResearch = researchReportSchema.parse(
      JSON.parse(readFileSync(result.researchPath, "utf8")),
    );
    const storedReport = generatedReportSchema.parse(
      JSON.parse(readFileSync(result.reportPath, "utf8")),
    );
    const auditEvents = readJsonLines(result.auditLogPath);

    expect(storedResearch).toMatchObject({
      reportId: result.researchReportId,
      taskId: result.researchTaskId,
      requiresHumanReview: true,
      metadata: {
        liveTrading: false,
        directExecutionAllowed: false,
        ignoredExecutionFields: ["orders", "execution"],
        brokerConnected: false,
        accountWriteAllowed: false,
      },
    });
    expect(storedResearch.tradeIntentDrafts.every((draft) => draft.executable === false)).toBe(true);
    expect(storedReport).toMatchObject({
      reportType: "midday_review",
      brainOutput: {
        provider: "mock",
      },
      metadata: {
        schedulerJobId: "paper-research-loop",
        researchReportId: result.researchReportId,
        liveTrading: false,
        directExecutionAllowed: false,
      },
    });
    expect(storedReport.recommendations.every((item) => item.executable === false)).toBe(true);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "write",
      correlationId: result.researchTaskId,
      metadata: {
        reportId: result.researchReportId,
        provider: "trading_agents_cn",
        tradeIntentDraftCount: 1,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain(storedResearch.summary);
    expect(existsSync(result.researchPath)).toBe(true);
    expect(existsSync(result.reportPath)).toBe(true);
    expect(existsSync(path.join(memoryDir, "portfolio"))).toBe(false);
  });

  it("does not reenter the same job and keeps running after callback failure", async () => {
    const runtime = createSchedulerRuntime({
      clock: {
        now: () => inSession,
      },
    });
    const deferred = createDeferred<void>();
    let calls = 0;
    let failNext = false;
    const runner = runtime.createMarketSentinelRunner({
      jobId: "paper-research-loop",
      task: async () => {
        calls += 1;

        if (failNext) {
          failNext = false;
          throw new Error("mock loop failed");
        }

        await deferred.promise;
      },
    });

    const first = runner.triggerOnce(inSession);
    const second = await runner.triggerOnce(inSession);

    expect(second.status).toBe("skipped_locked");
    expect(calls).toBe(1);

    deferred.resolve(undefined);
    expect((await first).status).toBe("completed");

    failNext = true;
    const failed = await runner.triggerOnce(inSession);
    expect(failed).toMatchObject({
      status: "failed",
      error: "mock loop failed",
    });

    const recovered = await runner.triggerOnce(inSession);
    expect(recovered.status).toBe("completed");
    expect(calls).toBe(3);
  });
});

interface MockLoopResult {
  jobId: string;
  beijingDate: string;
  eventType: CerebellumEvent["eventType"];
  provider: string;
  brainProvider: string;
  researchTaskId: string;
  researchReportId: string;
  researchPath: string;
  reportPath: string;
  auditLogPath: string;
  tradeIntentExecutable: boolean;
  reportRecommendationExecutable: boolean;
}

async function runMockPaperResearchLoop(
  context: SchedulerTaskContext,
  memoryDir: string,
): Promise<MockLoopResult> {
  const account = makeAccount(context.scheduledAt);
  const position = makePosition(context.scheduledAt);
  const quote = makeQuote(context.scheduledAt);
  const tradingDate = context.beijingTime.date;
  const sentinel = runMarketSentinelOnce({
    quotes: [quote],
    positions: [position],
    now: context.scheduledAt,
  });
  const event = sentinel.events[0];

  if (!event) {
    throw new Error("Expected MarketSentinel to emit one mock event");
  }

  const researchTask = researchTaskFromSentinelEvent(event, tradingDate);
  const generatedAt = new Date(Date.parse(context.scheduledAt) + 60_000).toISOString();
  const adapter = new TradingAgentsCnAdapter({
    runner: async (task) => ({
      title: `${task.symbol} scheduled mock research`,
      summary: "Scheduled mock research confirms the paper sentinel event requires review.",
      conclusion: "bearish",
      confidence: 75,
      findings: [
        {
          category: "risk",
          statement: "The scheduled runner observed a paper stop-loss event.",
          evidence: [event.message],
          confidence: 0.8,
        },
      ],
      bearish: [
        {
          thesis: "Manual review is required before any trading action.",
          evidence: [event.message],
          confidence: 0.8,
        },
      ],
      risks: [
        {
          severity: "critical",
          description: "Mock loop risk event.",
          mitigation: "Do not connect broker from scheduler callback.",
        },
      ],
      sources: [
        {
          title: "Scheduler mock MarketSentinel event",
          type: "system",
          observedAt: event.occurredAt,
        },
      ],
      recommendations: [
        {
          action: "sell",
          quantity: 100,
          price: quote.latestPrice,
          reason: "Non-executable scheduled research draft.",
        },
      ],
      orders: [{ orderId: "must-not-enter-scheduler-loop" }],
      execution: { status: "forbidden" },
    }),
    now: () => new Date(generatedAt),
    idGenerator: createIdGenerator(),
  });
  const researchStore = new ResearchMemoryStore({
    memoryDir,
    now: () => new Date(generatedAt),
    idGenerator: createIdGenerator(),
  });
  const researchResult = await runResearchOnce({
    task: researchTask,
    runner: adapter,
    writer: researchStore,
    writeToMemory: true,
    now: generatedAt,
  });
  const researchPaths = createResearchMemoryPaths(
    memoryDir,
    tradingDate,
    researchResult.report.reportId,
    generatedAt,
  );
  const reportStore = new ReportsMemoryStore({ memoryDir });
  const brainProvider = new MockBrainProvider({
    now: () => new Date(generatedAt),
  });
  const reportResult = await generateReport({
    reportType: "midday_review",
    account,
    positions: [position],
    quotes: [quote],
    brainProvider,
    writer: reportStore,
    tradingDate,
    now: generatedAt,
    riskNotes: [
      event.message,
      `Scheduled research report ${researchResult.report.reportId} requires manual review.`,
    ],
    metadata: {
      schedulerJobId: context.jobId,
      scheduledAt: context.scheduledAt,
      sentinelEventIds: [event.eventId],
      researchReportId: researchResult.report.reportId,
      paperResearchLoop: true,
    },
  });
  const reportPaths = createReportsMemoryPaths(memoryDir, tradingDate, "midday_review");

  return {
    jobId: context.jobId,
    beijingDate: tradingDate,
    eventType: event.eventType,
    provider: researchResult.report.provider,
    brainProvider: reportResult.report.brainOutput.provider,
    researchTaskId: researchTask.taskId,
    researchReportId: researchResult.report.reportId,
    researchPath: researchPaths.reportPath,
    reportPath: reportPaths.reportPath,
    auditLogPath: researchPaths.auditLogPath,
    tradeIntentExecutable: researchResult.report.tradeIntentDrafts.some((draft) => draft.executable),
    reportRecommendationExecutable: reportResult.report.recommendations.some((item) => item.executable),
  };
}

function researchTaskFromSentinelEvent(event: CerebellumEvent, tradingDate: string) {
  return researchTaskSchema.parse({
    taskId: `research-task-${event.eventId}`,
    symbol: event.symbol,
    market: event.market,
    name: event.name,
    tradingDate,
    objective: `Review ${event.symbol} after scheduled ${event.eventType}.`,
    context: {
      loop: "scheduler-paper-research",
      sentinelEvent: {
        eventId: event.eventId,
        eventType: event.eventType,
        severity: event.severity,
        message: event.message,
        occurredAt: event.occurredAt,
        currentPrice: event.currentPrice,
        previousPrice: event.previousPrice ?? null,
        changePct: event.changePct ?? null,
        threshold: event.threshold,
      },
    },
    createdAt: event.occurredAt,
  });
}

function makeAccount(now: string) {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: 19000,
      frozen: 0,
    },
    status: "active",
    createdAt: "2026-06-12T01:00:00.000Z",
    updatedAt: now,
  });
}

function makePosition(now: string) {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 9.1,
    currency: "CNY",
    openedAt: "2026-06-11T01:30:00.000Z",
    updatedAt: now,
  });
}

function makeQuote(now: string) {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    provider: "tencent",
    latestPrice: 9.1,
    previousClose: 10,
    changeAmount: -0.9,
    changePct: -0.09,
    receivedAt: now,
    rawSymbol: "sz000636",
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-scheduler-paper-research-loop-"));
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
