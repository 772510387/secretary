import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  researchReportSchema,
  researchTaskSchema,
  type ResearchReport,
} from "../../src/domain/research/index.js";
import {
  ResearchProviderError,
  TradingAgentsCnAdapter,
} from "../../src/infrastructure/providers/index.js";
import {
  ResearchMemoryStore,
  createResearchMemoryPaths,
} from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];
const generatedAt = "2026-06-12T08:30:00.000Z";

describe("TradingAgentsCnAdapter", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("maps external TradingAgents-CN output into a safe ResearchReport", async () => {
    const adapter = new TradingAgentsCnAdapter({
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
      runner: async () => ({
        title: "风华高科 TradingAgents-CN Research",
        summary: "Demand recovery is visible, but valuation and margin pressure require review.",
        conclusion: "bullish",
        confidence: 82,
        findings: [
          {
            category: "fundamental",
            statement: "MLCC demand recovery supports revenue stabilization.",
            evidence: ["Channel checks improved"],
            confidence: 0.7,
          },
        ],
        bullish: ["Inventory digestion may improve pricing power."],
        bearish: [{ thesis: "Margin pressure remains a watch item.", confidence: 0.4 }],
        risks: [
          {
            severity: "warning",
            description: "Consumer electronics demand can reverse quickly.",
            mitigation: "Keep position sizing conservative.",
          },
        ],
        sources: [
          {
            title: "Mock TradingAgents-CN analyst debate",
            type: "research",
            observedAt: generatedAt,
          },
        ],
        recommendations: [
          {
            action: "buy",
            quantity: 100,
            price: 10.5,
            reason: "Non-executable draft for later policy and risk checks.",
          },
        ],
        orders: [{ orderId: "must-not-propagate" }],
        execution: { status: "forbidden" },
      }),
    });

    const report = await adapter.runResearch(makeTask());

    expect(report).toMatchObject({
      provider: "trading_agents_cn",
      symbol: "000636",
      market: "SZSE",
      conclusion: "bullish",
      confidence: 0.82,
      requiresHumanReview: true,
      degraded: false,
    });
    expect(report.findings[0]).toMatchObject({
      category: "fundamental",
      statement: "MLCC demand recovery supports revenue stabilization.",
    });
    expect(report.bullBearViews.map((view) => view.side)).toEqual(["bull", "bear"]);
    expect(report.riskFactors[0]).toMatchObject({
      severity: "warning",
    });
    expect(report.tradeIntentDrafts[0]).toMatchObject({
      side: "BUY",
      quantity: 100,
      limitPrice: 10.5,
      source: "research",
      requiresReview: true,
      executable: false,
    });
    expect(report.metadata).toMatchObject({
      liveTrading: false,
      directExecutionAllowed: false,
      ignoredExecutionFields: ["orders", "execution"],
    });
    expect(JSON.stringify(report)).not.toContain("must-not-propagate");
  });

  it("returns a degraded ResearchReport when the external runner times out", async () => {
    const adapter = new TradingAgentsCnAdapter({
      timeoutMs: 5,
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
      runner: async () => new Promise(() => undefined),
    });

    const report = await adapter.runResearch(makeTask());

    expect(report.degraded).toBe(true);
    expect(report.conclusion).toBe("neutral");
    expect(report.confidence).toBe(0);
    expect(report.tradeIntentDrafts).toEqual([]);
    expect(report.summary).toContain("timed out");
  });

  it("throws a provider error when fallback is disabled", async () => {
    const adapter = new TradingAgentsCnAdapter({
      fallbackOnError: false,
      now: () => new Date(generatedAt),
      runner: async () => {
        throw new Error("external process failed");
      },
    });

    await expect(adapter.runResearch(makeTask())).rejects.toThrow(ResearchProviderError);
  });

  it("writes ResearchReport into memory/research with backup on overwrite", async () => {
    const memoryDir = createTempMemoryDir();
    const store = new ResearchMemoryStore({
      memoryDir,
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
    });
    const adapter = new TradingAgentsCnAdapter({
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
      runner: async () => ({
        summary: "Neutral research output.",
        conclusion: "neutral",
        findings: ["No decisive signal."],
      }),
    });
    const report = await adapter.runResearch(makeTask());

    const first = store.writeReport(report);
    const second = store.writeReport(report);
    const paths = createResearchMemoryPaths(
      memoryDir,
      report.tradingDate,
      report.reportId,
      generatedAt,
    );
    const stored = researchReportSchema.parse(JSON.parse(readFileSync(paths.reportPath, "utf8")));
    const auditEvents = readJsonLines(paths.auditLogPath);

    expect(first.filePath).toBe(paths.reportPath);
    expect(first.auditLogPath).toBe(paths.auditLogPath);
    expect(second.backupPath).toBeDefined();
    expect(existsSync(second.backupPath!)).toBe(true);
    expect(second.auditBackupPath).toBeDefined();
    expect(existsSync(second.auditBackupPath!)).toBe(true);
    expect(stored.reportId).toBe(report.reportId);
    expect(stored.provider).toBe("trading_agents_cn");
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      actor: {
        type: "system",
        id: "research-memory-store",
      },
      action: "write",
      subject: {
        type: "report",
        id: report.reportId,
      },
      severity: "info",
      result: "success",
      correlationId: report.taskId,
      metadata: {
        reportId: report.reportId,
        taskId: report.taskId,
        provider: "trading_agents_cn",
        symbol: report.symbol,
        market: report.market,
        tradingDate: report.tradingDate,
        degraded: false,
        tradeIntentDraftCount: 0,
        requiresHumanReview: true,
        filePath: paths.reportPath,
        backupPath: null,
        liveTrading: false,
      },
    });
    expect(auditEvents[1].metadata).toMatchObject({
      reportId: report.reportId,
      backupPath: second.backupPath,
    });
    expect(JSON.stringify(auditEvents)).not.toContain("Neutral research output.");
    expect(JSON.stringify(auditEvents)).not.toContain("No decisive signal.");
  });

  it("does not write a report or success audit when report schema validation fails", async () => {
    const memoryDir = createTempMemoryDir();
    const store = new ResearchMemoryStore({
      memoryDir,
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
    });
    const adapter = new TradingAgentsCnAdapter({
      now: () => new Date(generatedAt),
      idGenerator: createIdGenerator(),
      runner: async () => ({
        summary: "Neutral research output.",
        conclusion: "neutral",
        findings: ["No decisive signal."],
      }),
    });
    const report = await adapter.runResearch(makeTask());
    const invalidReport = {
      ...report,
      summary: "",
    } as ResearchReport;
    const paths = createResearchMemoryPaths(
      memoryDir,
      report.tradingDate,
      report.reportId,
      generatedAt,
    );

    expect(() => store.writeReport(invalidReport)).toThrow();
    expect(existsSync(paths.reportPath)).toBe(false);
    expect(existsSync(paths.auditLogPath)).toBe(false);
  });
});

function makeTask() {
  return researchTaskSchema.parse({
    taskId: "research-task-000636",
    symbol: "000636",
    market: "SZSE",
    name: "风华高科",
    tradingDate: "2026-06-12",
    objective: "Summarize stock research into a safe ResearchReport.",
    context: {
      latestPrice: 10.5,
    },
    createdAt: generatedAt,
  });
}

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-research-adapter-"));
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
