import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  researchTaskSchema,
} from "../../src/domain/research/index.js";
import {
  ResearchProviderError,
  TradingAgentsCnAdapter,
  TradingAgentsCnSubprocessRunner,
} from "../../src/infrastructure/providers/index.js";

const tempRoots: string[] = [];
const generatedAt = "2026-06-15T08:30:00.000Z";

describe("TradingAgentsCnSubprocessRunner", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("converts valid stdout JSON into a safe ResearchReport", async () => {
    const adapter = createAdapter(`
      readRequest((request) => {
        if (request.options.allowNetwork || request.options.allowBroker || request.options.allowOrders) {
          process.exit(12);
        }
        if ("account" in request.task.context || "orders" in request.task.context) {
          process.exit(13);
        }
        process.stdout.write(JSON.stringify({
          title: request.task.symbol + " fake subprocess research",
          summary: "Fake subprocess research found a cautious positive setup.",
          conclusion: "bullish",
          confidence: 0.76,
          findings: [
            {
              category: "technical",
              statement: "The fake runner observed a stable mock trend.",
              evidence: ["No real LLM, network, broker, or TradingAgents-CN app was called."],
              confidence: 0.7
            }
          ],
          bullish: ["Manual review can continue from this mock research."],
          risks: [
            {
              severity: "watch",
              description: "This is only fake subprocess output.",
              mitigation: "Keep the result non-executable."
            }
          ],
          recommendations: [
            {
              action: "buy",
              quantity: 100,
              price: 10.5,
              reason: "Draft only; must remain under manual review."
            }
          ],
          orders: [{ orderId: "must-not-propagate" }]
        }));
      });
    `);

    const report = await adapter.runResearch(makeTask());

    expect(report).toMatchObject({
      provider: "trading_agents_cn",
      conclusion: "bullish",
      confidence: 0.76,
      degraded: false,
      requiresHumanReview: true,
    });
    expect(report.tradeIntentDrafts[0]).toMatchObject({
      side: "BUY",
      source: "research",
      requiresReview: true,
      executable: false,
    });
    expect(report.metadata).toMatchObject({
      liveTrading: false,
      directExecutionAllowed: false,
      ignoredExecutionFields: ["orders"],
    });
    expect(JSON.stringify(report)).not.toContain("must-not-propagate");
  });

  it("parses SECRETARY_RESULT_JSON prefixed output", async () => {
    const adapter = createAdapter(`
      readRequest((request) => {
        process.stdout.write("fake TradingAgents-CN progress log\\n");
        process.stdout.write("SECRETARY_RESULT_JSON:" + JSON.stringify({
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          status: "ok",
          report: {
            title: "prefixed fake subprocess research",
            summary: "Prefixed output was parsed as the final result.",
            conclusion: "neutral",
            confidence: 0.55,
            findings: ["The prefixed result line wins over progress logs."],
            sources: [
              {
                title: "Fake subprocess",
                type: "system",
                observedAt: "${generatedAt}"
              }
            ]
          }
        }) + "\\n");
      });
    `);

    const report = await adapter.runResearch(makeTask());

    expect(report).toMatchObject({
      conclusion: "neutral",
      confidence: 0.55,
      degraded: false,
    });
    expect(report.summary).toContain("Prefixed output");
    expect(report.sources[0]).toMatchObject({
      title: "Fake subprocess",
      sourceType: "system",
    });
  });

  it("returns a degraded report with redacted stderr on non-zero exit", async () => {
    const adapter = createAdapter(`
      readRequest(() => {
        process.stderr.write("api_key=sk-live-secret token=raw-token cookie=session-cookie Bearer bearer-secret");
        process.exit(7);
      });
    `);

    const report = await adapter.runResearch(makeTask());
    const serialized = JSON.stringify(report);

    expect(report.degraded).toBe(true);
    expect(report.summary).toContain("exited with code 7");
    expect(serialized).toContain("<redacted>");
    expect(serialized).not.toContain("sk-live-secret");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("session-cookie");
    expect(serialized).not.toContain("bearer-secret");
    expect(report.tradeIntentDrafts).toEqual([]);
  });

  it("throws ResearchProviderError on non-zero exit when fallback is disabled", async () => {
    const adapter = createAdapter(
      `
        readRequest(() => {
          process.stderr.write("secret=sk-should-not-leak");
          process.exit(5);
        });
      `,
      { fallbackOnError: false },
    );

    await expect(adapter.runResearch(makeTask())).rejects.toThrow(ResearchProviderError);
    await expect(adapter.runResearch(makeTask())).rejects.not.toThrow("sk-should-not-leak");
  });

  it("degrades on bad JSON and empty stdout", async () => {
    const badJsonAdapter = createAdapter(`
      readRequest(() => {
        process.stdout.write("{not-json");
      });
    `);
    const emptyOutputAdapter = createAdapter(`
      readRequest(() => {
        process.exit(0);
      });
    `);

    const badJsonReport = await badJsonAdapter.runResearch(makeTask());
    const emptyOutputReport = await emptyOutputAdapter.runResearch(makeTask());

    expect(badJsonReport).toMatchObject({
      degraded: true,
      confidence: 0,
    });
    expect(badJsonReport.summary).toContain("invalid JSON");
    expect(emptyOutputReport).toMatchObject({
      degraded: true,
      confidence: 0,
    });
    expect(emptyOutputReport.summary).toContain("empty stdout");
  });

  it("terminates a fake subprocess on timeout", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "secretary-ta-cn-runner-"));
    tempRoots.push(tempRoot);
    const markerPath = path.join(tempRoot, "still-running.txt");
    const adapter = createAdapter(
      `
        const fs = require("node:fs");
        const markerPath = process.argv[1];
        process.stdin.resume();
        setTimeout(() => {
          fs.writeFileSync(markerPath, "process was not terminated", "utf8");
        }, 250);
        setInterval(() => undefined, 1000);
      `,
      {
        args: [markerPath],
        timeoutMs: 30,
      },
    );

    const report = await adapter.runResearch(makeTask());
    await sleep(350);

    expect(report.degraded).toBe(true);
    expect(report.summary).toContain("timed out");
    expect(report.tradeIntentDrafts).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  });
});

function createAdapter(
  body: string,
  options: {
    args?: readonly string[];
    fallbackOnError?: boolean;
    timeoutMs?: number;
  } = {},
): TradingAgentsCnAdapter {
  const runner = new TradingAgentsCnSubprocessRunner({
    command: process.execPath,
    args: [
      "-e",
      `${readRequestHelper()}\n${body}`,
      ...(options.args ?? []),
    ],
    requestIdGenerator: () => "research-run-000636",
    killGraceMs: 10,
  });

  return new TradingAgentsCnAdapter({
    runner: runner.run,
    fallbackOnError: options.fallbackOnError ?? true,
    timeoutMs: options.timeoutMs ?? 1_000,
    now: () => new Date(generatedAt),
    idGenerator: createIdGenerator(),
  });
}

function readRequestHelper(): string {
  return `
    function readRequest(callback) {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        callback(JSON.parse(input));
      });
    }
  `;
}

function makeTask() {
  return researchTaskSchema.parse({
    taskId: "research-task-000636",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    tradingDate: "2026-06-15",
    objective: "Run fake TradingAgents-CN subprocess research.",
    context: {
      latestPrice: 10.5,
      account: {
        accountId: "paper-main",
      },
      orders: [
        {
          orderId: "must-not-leave-secretary",
        },
      ],
      note: "No broker or network access.",
      apiKey: "sk-context-secret",
    },
    createdAt: generatedAt,
  });
}

function createIdGenerator(): () => string {
  let id = 0;

  return () => {
    id += 1;
    return String(id).padStart(4, "0");
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
