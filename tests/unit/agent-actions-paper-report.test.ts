import { describe, expect, it } from "vitest";
import { buildPaperOpsMarkdownReport } from "../../scripts/dev/agent-actions.js";
import type { ReplayDayRunResult } from "../../scripts/dev/cerebellum-daemon.js";
import type { BrainInput, BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";

const ASOF = "2026-06-24T01:00:00.000Z";

class MarkdownBrain implements BrainProvider {
  readonly providerName = "dashscope" as const;
  capturedInput: BrainInput | undefined;

  constructor(private readonly summary: string) {}

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.capturedInput = input;
    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "stub-qwen",
      taskType: input.taskType,
      generatedAt: ASOF,
      summary: this.summary,
      structured: { format: "markdown" },
      citations: [],
      confidence: 0.8,
      proposals: [],
    };
  }
}

class FailingBrain implements BrainProvider {
  readonly providerName = "dashscope" as const;

  async generate(): Promise<BrainOutput> {
    throw new Error("provider down");
  }
}

const ACTION = {
  type: "paper_ops",
  replayDate: "2026-06-22",
} as const;

const REPLAY: ReplayDayRunResult = {
  date: "2026-06-22",
  nodeCount: 1,
  nodes: [
    {
      alarmType: "call_auction_watch",
      beijingTime: "09:15",
      report: "模型基于池内候选选择一笔可执行建仓。",
      funnel: {
        alarmType: "call_auction_watch",
        planId: "plan-1",
        shortlistCount: 10,
        autoPaper: true,
        degraded: false,
        proposals: [
          {
            proposalId: "proposal-1",
            side: "BUY",
            symbol: "600522",
            name: "中天科技",
            quantity: 100,
            limitPrice: 56.55,
            rationale: "可执行候选中趋势强，账户现金可覆盖一手。",
          },
        ],
        executions: [
          {
            side: "BUY",
            symbol: "600522",
            name: "中天科技",
            status: "filled",
            quantity: 100,
            limitPrice: 56.55,
          },
        ],
      },
    },
  ],
};

describe("paper ops markdown report", () => {
  it("uses a real brain provider to produce the final markdown report", async () => {
    const brain = new MarkdownBrain(
      [
        "# 模拟运维结果",
        "",
        "## 执行范围",
        "- 已忠实重演 2026-06-22",
        "",
        "## 操作回放",
        "- 09:15 call_auction_watch：BUY 600522 中天科技 100股@56.55，filled。",
      ].join("\n"),
    );

    const report = await buildPaperOpsMarkdownReport({
      action: ACTION,
      completed: ["已忠实重演 2026-06-22"],
      notifications: ["【模拟盘后端处理】BUY 600522 filled"],
      replayResults: [REPLAY],
      brainProvider: brain,
      now: () => new Date(ASOF),
    });

    expect(report).toContain("# 模拟运维结果");
    expect(report).toContain("## 操作回放");
    expect(report).toContain("100股@56.55");
    expect(brain.capturedInput?.constraints.outputFormat).toBe("markdown");
    expect(JSON.stringify(brain.capturedInput?.context)).toContain("600522");
    expect(JSON.stringify(brain.capturedInput?.context)).toContain("filled");
  });

  it("falls back to deterministic markdown when the brain provider fails", async () => {
    const report = await buildPaperOpsMarkdownReport({
      action: ACTION,
      completed: ["已忠实重演 2026-06-22"],
      notifications: ["【模拟盘后端处理】BUY 600522 filled"],
      replayResults: [REPLAY],
      brainProvider: new FailingBrain(),
      now: () => new Date(ASOF),
    });

    expect(report).toContain("# 模拟运维结果");
    expect(report).toContain("## 执行范围");
    expect(report).toContain("## 成交与未成交");
    expect(report).toContain("BUY 600522 中天科技，filled 100股@56.55");
  });
});
