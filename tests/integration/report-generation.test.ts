import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateDailyReports,
  generateReport,
  generatedReportSchema,
  type ReportType,
} from "../../src/app/index.js";
import { BrainValidationError, type BrainInput } from "../../src/domain/brain/index.js";
import {
  accountSchema,
  positionSchema,
} from "../../src/domain/portfolio/index.js";
import { quoteSnapshotSchema } from "../../src/domain/market/index.js";
import { MockBrainProvider } from "../../src/infrastructure/providers/index.js";
import {
  ReportsMemoryStore,
  createReportsMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const fixedNow = "2026-06-12T08:00:00.000Z";
const tradingDate = "2026-06-12";
const reportTypes: ReportType[] = [
  "pre_market_plan",
  "midday_review",
  "closing_review",
  "daily_reflection",
];

describe("report generation", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("generates and writes all daily reports with MockBrainProvider", async () => {
    const memoryDir = createTempMemoryDir();
    const writer = new ReportsMemoryStore({ memoryDir });
    const brainProvider = new MockBrainProvider({
      now: () => new Date(fixedNow),
    });

    const results = await generateDailyReports({
      account: makeAccount(),
      positions: [makePosition()],
      quotes: [makeQuote()],
      riskNotes: ["8% hard stop-loss remains active."],
      brainProvider,
      writer,
      now: fixedNow,
      tradingDate,
      metadata: {
        linkedAuditIds: ["audit-report-001"],
      },
    });

    expect(results.map((result) => result.report.reportType)).toEqual(reportTypes);

    for (const reportType of reportTypes) {
      const paths = createReportsMemoryPaths(memoryDir, tradingDate, reportType);
      expect(existsSync(paths.reportPath)).toBe(true);

      const report = generatedReportSchema.parse(JSON.parse(readFileSync(paths.reportPath, "utf8")));

      expect(report).toMatchObject({
        reportType,
        tradingDate,
        generatedAt: fixedNow,
        accountSummary: {
          accountId: "paper-main",
          cashAvailable: 20000,
        },
        marketSummary: {
          quoteCount: 1,
        },
        brainOutput: {
          provider: "mock",
          taskType: reportType,
        },
        metadata: {
          period: "daily",
          symbols: ["000636"],
          marketSummary: "1 quote snapshots; average change 5.00%; 1 positions in context.",
          decisionSummary: "1 non-executable recommendations; manual review is required before any trade intent or memory proposal.",
          linkedAuditIds: ["audit-report-001"],
          liveTrading: false,
          directExecutionAllowed: false,
        },
      });
      expect(report.metadata).toHaveProperty("riskNotes");
      expect(JSON.stringify(report.metadata)).not.toContain(report.contentMarkdown);
      expect(report.positionSummary).toMatchObject({
        positionCount: 1,
        totalMarketValue: 1050,
        unrealizedPnl: 50,
      });
      expect(report.facts.length).toBeGreaterThan(0);
      expect(report.inferences.length).toBeGreaterThan(0);
      expect(report.riskSummary).toContain("8% hard stop-loss remains active.");
      expect(report.recommendations.length).toBeGreaterThan(0);
      expect(report.recommendations.every((item) => item.executable === false)).toBe(true);
      expect(report.contentMarkdown).toContain("All recommendations are non-executable drafts.");
    }
  });

  it("creates a backup when overwriting an existing report", async () => {
    const memoryDir = createTempMemoryDir();
    const writer = new ReportsMemoryStore({ memoryDir });
    const brainProvider = new MockBrainProvider({
      now: () => new Date(fixedNow),
    });

    const first = await generateReport({
      reportType: "pre_market_plan",
      account: makeAccount(),
      positions: [],
      quotes: [],
      brainProvider,
      writer,
      now: fixedNow,
      tradingDate,
    });
    const second = await generateReport({
      reportType: "pre_market_plan",
      account: makeAccount(),
      positions: [],
      quotes: [],
      brainProvider,
      writer,
      now: fixedNow,
      tradingDate,
    });

    expect(first.write.filePath).toBe(second.write.filePath);
    expect(second.write.backupPath).toBeDefined();
    expect(existsSync(second.write.backupPath!)).toBe(true);
  });

  it("rejects invalid brain structured output and does not write a report", async () => {
    const memoryDir = createTempMemoryDir();
    const writer = new ReportsMemoryStore({ memoryDir });
    const brainProvider = new MockBrainProvider({
      now: () => new Date(fixedNow),
      responseFactory: (input: BrainInput) => ({
        requestId: input.requestId,
        provider: "mock",
        model: "mock-brain-v1",
        taskType: input.taskType,
        generatedAt: fixedNow,
        summary: "Invalid structured report payload.",
        structured: {
          taskType: input.taskType,
        },
        citations: [],
        confidence: 0.5,
        proposals: [],
      }),
    });

    await expect(
      generateReport({
        reportType: "pre_market_plan",
        account: makeAccount(),
        positions: [],
        quotes: [],
        brainProvider,
        writer,
        now: fixedNow,
        tradingDate,
      }),
    ).rejects.toThrow(BrainValidationError);

    const paths = createReportsMemoryPaths(memoryDir, tradingDate, "pre_market_plan");
    expect(existsSync(paths.reportPath)).toBe(false);
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-report-generation-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function makeAccount() {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: 20000,
      frozen: 0,
    },
    status: "active",
    createdAt: fixedNow,
    updatedAt: fixedNow,
  });
}

function makePosition() {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 10.5,
    currency: "CNY",
    openedAt: fixedNow,
    updatedAt: fixedNow,
  });
}

function makeQuote() {
  return quoteSnapshotSchema.parse({
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    provider: "tencent",
    latestPrice: 10.5,
    previousClose: 10,
    changeAmount: 0.5,
    changePct: 0.05,
    receivedAt: fixedNow,
    rawSymbol: "sz000636",
  });
}
