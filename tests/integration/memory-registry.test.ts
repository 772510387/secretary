import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRegistry } from "../../src/infrastructure/storage/index.js";

const tempRoots: string[] = [];

describe("MemoryRegistry", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, {
          recursive: true,
          force: true,
        });
      }
    }
  });

  it("lists documents by memory category without scanning unrelated runtime data", () => {
    const memoryDir = createTempMemoryDir();
    writeMemoryFile(memoryDir, "rules/core.md", "# Core Rules\nT+1 and stop-loss rules.");
    writeMemoryFile(memoryDir, "research/2026-06-14/research-000636.json", researchJson());
    writeMemoryFile(memoryDir, "reports/2026-06-14/daily_reflection.json", reportJson());
    writeMemoryFile(memoryDir, "proposals/2026-06-14/proposal-001.json", proposalJson());
    writeMemoryFile(memoryDir, "logs/audit-2026-06-14.jsonl", auditLineJson());
    writeMemoryFile(memoryDir, "portfolio/account.json", JSON.stringify({ accountId: "secret" }));
    const registry = new MemoryRegistry({ memoryDir });

    const documents = registry.listDocuments();

    expect(documents.map((item) => item.category).sort()).toEqual([
      "logs",
      "proposals",
      "reports",
      "research",
      "rules",
    ]);
    expect(documents.map((item) => item.relativePath)).not.toContain("portfolio/account.json");
    expect(registry.listDocuments({ categories: ["rules"] })).toHaveLength(1);
    expect(registry.listDocuments({ categories: ["rules"] })[0]).toMatchObject({
      category: "rules",
      documentId: "core",
      title: "Core Rules",
      kind: "markdown",
      relativePath: "rules/core.md",
    });
  });

  it("searches keywords and returns sanitized snippets", () => {
    const memoryDir = createTempMemoryDir();
    writeMemoryFile(
      memoryDir,
      "rules/core.md",
      "# Core Rules\nStop-loss remains 8%. OPENAI_API_KEY=sk-test-secret must not leak.",
    );
    writeMemoryFile(
      memoryDir,
      "logs/audit-2026-06-14.jsonl",
      JSON.stringify({
        message: "stop-loss audit",
        metadata: {
          token: "very-secret-token",
        },
      }),
    );
    const registry = new MemoryRegistry({ memoryDir });

    const results = registry.search({
      query: "stop-loss",
      categories: ["rules", "logs"],
      limit: 10,
      snippetLength: 120,
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.matchCount).toBeGreaterThanOrEqual(1);
    expect(results.map((item) => item.document.category).sort()).toEqual(["logs", "rules"]);
    expect(JSON.stringify(results)).not.toContain("sk-test-secret");
    expect(JSON.stringify(results)).not.toContain("very-secret-token");
    expect(JSON.stringify(results)).toContain("[REDACTED_SECRET]");
  });

  it("filters documents and search results by category and time range", () => {
    const memoryDir = createTempMemoryDir();
    writeMemoryFile(
      memoryDir,
      "reports/2026-06-13/old.json",
      reportJson({
        reportId: "old-report",
        title: "Old Report",
        generatedAt: "2026-06-13T08:00:00.000Z",
        contentMarkdown: "# Old\nstop-loss note token=old-secret",
      }),
      "2026-06-13T08:00:00.000Z",
    );
    writeMemoryFile(
      memoryDir,
      "reports/2026-06-15/new.json",
      reportJson({
        reportId: "new-report",
        title: "New Report",
        generatedAt: "2026-06-15T08:00:00.000Z",
        contentMarkdown: "# New\nstop-loss note token=new-secret",
      }),
      "2026-06-15T08:00:00.000Z",
    );
    writeMemoryFile(
      memoryDir,
      "research/2026-06-15/research.json",
      researchJson({
        reportId: "research-in-window",
        generatedAt: "2026-06-15T09:00:00.000Z",
        summary: "stop-loss research body",
      }),
      "2026-06-15T09:00:00.000Z",
    );
    const registry = new MemoryRegistry({ memoryDir });

    const documents = registry.listDocuments({
      category: "reports",
      from: "2026-06-14T00:00:00.000Z",
      to: "2026-06-16T00:00:00.000Z",
      limit: 1,
    });
    const results = registry.search({
      query: "stop-loss",
      category: "reports",
      from: "2026-06-14T00:00:00.000Z",
      to: "2026-06-16T00:00:00.000Z",
      limit: 5,
      snippetLength: 120,
    });

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      category: "reports",
      relativePath: "reports/2026-06-15/new.json",
      updatedAt: "2026-06-15T08:00:00.000Z",
      metadata: {
        extension: ".json",
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      path: "reports/2026-06-15/new.json",
      updatedAt: "2026-06-15T08:00:00.000Z",
      metadata: {
        extension: ".json",
      },
    });
    expect(results[0]?.summary).toContain("stop-loss");
    expect(JSON.stringify(results)).not.toContain("new-secret");
  });

  it("returns recent research metadata without full research body", () => {
    const memoryDir = createTempMemoryDir();
    const longSummary =
      "This is a long research summary that should not be returned by recent metadata.";
    writeMemoryFile(
      memoryDir,
      "research/2026-06-13/research-old.json",
      researchJson({
        reportId: "research-old",
        title: "Old Research",
        tradingDate: "2026-06-13",
        generatedAt: "2026-06-13T08:00:00.000Z",
        summary: longSummary,
      }),
    );
    writeMemoryFile(
      memoryDir,
      "research/2026-06-14/research-new.json",
      researchJson({
        reportId: "research-new",
        title: "New Research",
        tradingDate: "2026-06-14",
        generatedAt: "2026-06-14T08:00:00.000Z",
        summary: longSummary,
      }),
    );
    const registry = new MemoryRegistry({ memoryDir });

    const recent = registry.recent({ category: "research", limit: 1 });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      category: "research",
      documentId: "research-new",
      title: "New Research",
      tradingDate: "2026-06-14",
      generatedAt: "2026-06-14T08:00:00.000Z",
      metadata: {
        provider: "trading_agents_cn",
        symbol: "000636",
        market: "SZSE",
        conclusion: "neutral",
        confidence: 0.6,
        degraded: false,
        requiresHumanReview: true,
      },
    });
    expect(JSON.stringify(recent)).not.toContain(longSummary);
  });

  it("returns recent report metadata without report markdown", () => {
    const memoryDir = createTempMemoryDir();
    const contentMarkdown = "# Daily Reflection\nFull report body must not be returned.";
    writeMemoryFile(
      memoryDir,
      "reports/2026-06-14/daily_reflection.json",
      reportJson({
        reportId: "report-daily-reflection-2026-06-14",
        title: "2026-06-14 Daily Reflection",
        generatedAt: "2026-06-14T21:00:00.000Z",
        contentMarkdown,
      }),
    );
    const registry = new MemoryRegistry({ memoryDir });

    const recent = registry.recent({ category: "reports", limit: 5 });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      category: "reports",
      documentId: "report-daily-reflection-2026-06-14",
      title: "2026-06-14 Daily Reflection",
      tradingDate: "2026-06-14",
      generatedAt: "2026-06-14T21:00:00.000Z",
      metadata: {
        reportType: "daily_reflection",
        positionCount: 1,
        quoteCount: 1,
        liveTrading: false,
      },
    });
    expect(JSON.stringify(recent)).not.toContain(contentMarkdown);
  });

  it("returns standardized review metadata within a recent time range", () => {
    const memoryDir = createTempMemoryDir();
    const contentMarkdown = "# Closing Review\nFull report body should not be returned.";
    writeMemoryFile(
      memoryDir,
      "reports/2026-06-14/closing_review.json",
      reportJson({
        reportId: "report-closing-review-2026-06-14",
        reportType: "closing_review",
        title: "2026-06-14 Closing Review",
        generatedAt: "2026-06-14T15:30:00.000Z",
        contentMarkdown,
        metadata: {
          period: "daily",
          symbols: ["000636", "600519"],
          marketSummary: "2 quote snapshots; token=secret-market should be redacted.",
          decisionSummary: "Hold all proposals for manual review.",
          riskNotes: ["8% hard stop-loss remains active."],
          linkedAuditIds: ["audit-report-001"],
          liveTrading: false,
        },
      }),
      "2026-06-14T15:30:00.000Z",
    );
    writeMemoryFile(
      memoryDir,
      "reports/2026-06-11/closing_review.json",
      reportJson({
        reportId: "report-closing-review-2026-06-11",
        generatedAt: "2026-06-11T15:30:00.000Z",
      }),
      "2026-06-11T15:30:00.000Z",
    );
    const registry = new MemoryRegistry({ memoryDir });

    const recent = registry.recent({
      category: "reports",
      from: "2026-06-14T00:00:00.000Z",
      to: "2026-06-15T00:00:00.000Z",
      limit: 5,
    });

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      category: "reports",
      documentId: "report-closing-review-2026-06-14",
      path: "reports/2026-06-14/closing_review.json",
      summary: "closing_review daily metadata with 1 quote snapshots.",
      updatedAt: "2026-06-14T15:30:00.000Z",
      metadata: {
        reportType: "closing_review",
        period: "daily",
        symbols: ["000636", "600519"],
        marketSummary: "2 quote snapshots; [REDACTED_SECRET] should be redacted.",
        decisionSummary: "Hold all proposals for manual review.",
        riskNotes: ["8% hard stop-loss remains active."],
        linkedAuditIds: ["audit-report-001"],
        liveTrading: false,
      },
    });
    expect(JSON.stringify(recent)).not.toContain(contentMarkdown);
    expect(JSON.stringify(recent)).not.toContain("secret-market");
  });
});

function createTempMemoryDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-memory-registry-"));
  tempRoots.push(root);
  return path.join(root, "memory");
}

function writeMemoryFile(
  memoryDir: string,
  relativePath: string,
  content: string,
  updatedAt?: string,
): void {
  const filePath = path.join(memoryDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");

  if (updatedAt !== undefined) {
    const date = new Date(updatedAt);
    utimesSync(filePath, date, date);
  }
}

function researchJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reportId: "research-000636-2026-06-14",
    taskId: "research-task-000636",
    provider: "trading_agents_cn",
    symbol: "000636",
    market: "SZSE",
    tradingDate: "2026-06-14",
    generatedAt: "2026-06-14T08:00:00.000Z",
    title: "000636 Research",
    summary: "Research summary body.",
    conclusion: "neutral",
    confidence: 0.6,
    findings: [],
    bullBearViews: [],
    riskFactors: [],
    sources: [],
    tradeIntentDrafts: [],
    requiresHumanReview: true,
    degraded: false,
    metadata: {
      liveTrading: false,
    },
    ...overrides,
  });
}

function reportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reportId: "report-daily-reflection-2026-06-14",
    reportType: "daily_reflection",
    title: "2026-06-14 Daily Reflection",
    tradingDate: "2026-06-14",
    generatedAt: "2026-06-14T21:00:00.000Z",
    positionSummary: {
      positionCount: 1,
    },
    marketSummary: {
      quoteCount: 1,
    },
    contentMarkdown: "# Full report body",
    metadata: {
      liveTrading: false,
    },
    ...overrides,
  });
}

function proposalJson(): string {
  return JSON.stringify({
    proposalId: "proposal-001",
    proposalType: "memory_write_review",
    status: "pending_review",
    title: "Memory write proposal",
  });
}

function auditLineJson(): string {
  return JSON.stringify({
    eventId: "audit-001",
    message: "audit line",
  });
}
