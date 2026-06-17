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
import type { CerebellumEvent } from "../../src/domain/cerebellum/index.js";
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
import {
  ReportsMemoryStore,
  ResearchMemoryStore,
  createReportsMemoryPaths,
  createResearchMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const checkedAt = "2026-06-12T09:30:00.000Z";
const generatedAt = "2026-06-12T09:31:00.000Z";
const tradingDate = "2026-06-12";

describe("paper research loop", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("flows from a mock sentinel event to research, report generation, and audit metadata", async () => {
    const memoryDir = createTempMemoryDir();
    const account = makeAccount();
    const position = makePosition();
    const quote = makeQuote();
    const sentinel = runMarketSentinelOnce({
      quotes: [quote],
      positions: [position],
      now: checkedAt,
    });
    const event = sentinel.events[0];

    expect(sentinel.events).toHaveLength(1);
    expect(event).toMatchObject({
      eventType: "position_stop_loss",
      severity: "critical",
      symbol: "000636",
      wakeBrain: true,
      source: "market_sentinel",
    });

    const researchTask = researchTaskFromSentinelEvent(event);
    const adapter = new TradingAgentsCnAdapter({
      runner: async (task) => ({
        title: `${task.symbol} mock paper research loop`,
        summary: "Mock adapter research confirms the sentinel stop-loss event needs review.",
        conclusion: "bearish",
        confidence: 70,
        findings: [
          {
            category: "risk",
            statement: "The paper position crossed the configured stop-loss threshold.",
            evidence: [event.message],
            confidence: 0.8,
          },
        ],
        bearish: [
          {
            thesis: "Risk control is more important than adding exposure after a stop-loss event.",
            evidence: [event.message],
            confidence: 0.8,
          },
        ],
        risks: [
          {
            severity: "critical",
            description: "The loop detected a paper stop-loss event.",
            mitigation: "Create only a manual review draft; do not submit orders.",
          },
        ],
        sources: [
          {
            title: "Mock MarketSentinel event",
            type: "system",
            observedAt: event.occurredAt,
          },
        ],
        recommendations: [
          {
            action: "sell",
            quantity: 100,
            price: quote.latestPrice,
            reason: "Non-executable research draft for manual review only.",
          },
        ],
        orders: [{ orderId: "must-not-enter-loop" }],
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
    const storedResearch = researchReportSchema.parse(
      JSON.parse(readFileSync(researchPaths.reportPath, "utf8")),
    );

    expect(researchResult.mode).toBe("memory_write");
    expect(researchResult.write).toMatchObject({
      filePath: researchPaths.reportPath,
      auditLogPath: researchPaths.auditLogPath,
    });
    expect(storedResearch).toMatchObject({
      provider: "trading_agents_cn",
      taskId: researchTask.taskId,
      symbol: event.symbol,
      market: event.market,
      conclusion: "bearish",
      requiresHumanReview: true,
      degraded: false,
    });
    expect(storedResearch.tradeIntentDrafts).toHaveLength(1);
    expect(storedResearch.tradeIntentDrafts[0]).toMatchObject({
      side: "SELL",
      source: "research",
      requiresReview: true,
      executable: false,
    });
    expect(storedResearch.metadata).toMatchObject({
      liveTrading: false,
      directExecutionAllowed: false,
      ignoredExecutionFields: ["orders", "execution"],
      brokerConnected: false,
      accountWriteAllowed: false,
    });
    expect(JSON.stringify(storedResearch)).not.toContain("must-not-enter-loop");

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
        `Research report ${storedResearch.reportId} requires manual review.`,
      ],
      metadata: {
        sentinelEventIds: [event.eventId],
        researchReportId: storedResearch.reportId,
        paperResearchLoop: true,
      },
    });
    const reportPaths = createReportsMemoryPaths(memoryDir, tradingDate, "midday_review");
    const storedReport = generatedReportSchema.parse(
      JSON.parse(readFileSync(reportPaths.reportPath, "utf8")),
    );

    expect(reportResult.write.filePath).toBe(reportPaths.reportPath);
    expect(storedReport).toMatchObject({
      reportType: "midday_review",
      tradingDate,
      brainOutput: {
        provider: "mock",
      },
      metadata: {
        researchReportId: storedResearch.reportId,
        paperResearchLoop: true,
        liveTrading: false,
        directExecutionAllowed: false,
      },
    });
    expect(storedReport.riskSummary).toContain(event.message);
    expect(storedReport.recommendations.length).toBeGreaterThan(0);
    expect(storedReport.recommendations.every((item) => item.executable === false)).toBe(true);

    const auditEvents = readJsonLines(researchPaths.auditLogPath);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "write",
      subject: {
        type: "report",
        id: storedResearch.reportId,
      },
      correlationId: researchTask.taskId,
      metadata: {
        reportId: storedResearch.reportId,
        taskId: researchTask.taskId,
        provider: "trading_agents_cn",
        symbol: event.symbol,
        market: event.market,
        tradingDate,
        degraded: false,
        tradeIntentDraftCount: 1,
        requiresHumanReview: true,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(auditEvents)).not.toContain(storedResearch.summary);
    expect(JSON.stringify(auditEvents)).not.toContain(
      storedResearch.tradeIntentDrafts[0].rationale,
    );
    expect(existsSync(researchPaths.reportPath)).toBe(true);
    expect(existsSync(reportPaths.reportPath)).toBe(true);
    expect(existsSync(path.join(memoryDir, "portfolio"))).toBe(false);
  });
});

function researchTaskFromSentinelEvent(event: CerebellumEvent) {
  return researchTaskSchema.parse({
    taskId: `research-task-${event.eventId}`,
    symbol: event.symbol,
    market: event.market,
    name: event.name,
    tradingDate,
    objective: `Review ${event.symbol} after MarketSentinel emitted ${event.eventType}.`,
    context: {
      loop: "paper-research",
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

function makeAccount() {
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
    createdAt: "2026-06-12T09:00:00.000Z",
    updatedAt: checkedAt,
  });
}

function makePosition() {
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
    openedAt: "2026-06-11T09:30:00.000Z",
    updatedAt: checkedAt,
  });
}

function makeQuote() {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    provider: "tencent",
    latestPrice: 9.1,
    previousClose: 10,
    changeAmount: -0.9,
    changePct: -0.09,
    receivedAt: checkedAt,
    rawSymbol: "sz000636",
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-paper-research-loop-"));
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
