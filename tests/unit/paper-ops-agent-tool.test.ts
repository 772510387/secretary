import { describe, expect, it, vi } from "vitest";
import {
  buildPaperAgentTools,
  planAgentTurn,
  type PaperAgentToolDeps,
  type PaperPortfolioView,
} from "../../src/app/index.js";
import type { BrainOutput, BrainProvider } from "../../src/domain/brain/index.js";

const portfolio: PaperPortfolioView = {
  accountId: "paper-1",
  availableCash: 50_000,
  totalCash: 50_000,
  totalAssets: 50_000,
  totalPositionMarketValue: 0,
  totalUnrealizedPnl: 0,
  investedRatio: 0,
  positions: [],
  pricesAvailable: true,
};

function baseDeps(overrides: Partial<PaperAgentToolDeps> = {}): PaperAgentToolDeps {
  return {
    loadPortfolio: () => portfolio,
    executePaperOrder: () => ({ status: "filled", quantity: 100, limitPrice: 10 }),
    ...overrides,
  };
}

describe("run_paper_ops agent tool (intent = model picks the tool)", () => {
  it("is exposed only when executePaperOps dep is provided", () => {
    expect(buildPaperAgentTools(baseDeps()).specs.map((s) => s.name)).not.toContain("run_paper_ops");
    const withOps = buildPaperAgentTools(baseDeps({ executePaperOps: () => "ok" }));
    expect(withOps.specs.map((s) => s.name)).toContain("run_paper_ops");
  });

  it("runs the deterministic replay backend and surfaces it as a mutating operation", async () => {
    const executePaperOps = vi.fn(async (command: { replayDate?: string }) => {
      return `已按时点遮掩忠实重演 ${command.replayDate}；后端 2 笔纸面成交已写库。`;
    });
    const tools = buildPaperAgentTools(baseDeps({ executePaperOps }));

    const result = await tools.execute({
      id: "c1",
      name: "run_paper_ops",
      arguments: JSON.stringify({ replayDate: "2026-06-22" }),
    });

    expect(executePaperOps).toHaveBeenCalledOnce();
    expect(executePaperOps.mock.calls[0]![0]!.replayDate).toBe("2026-06-22");
    expect(result.effect?.kind).toBe("paper_ops");
    expect(result.effect?.mutated).toBe(true);
    expect(result.effect?.summary).toContain("重演 2026-06-22");
    expect(result.effect?.summary).toContain("已写库");
  });

  it("rejects a call with no date target", async () => {
    const tools = buildPaperAgentTools(baseDeps({ executePaperOps: () => "ok" }));
    const result = await tools.execute({ id: "c", name: "run_paper_ops", arguments: "{}" });
    expect(result.isError).toBe(true);
  });
});

/** A planner provider whose structured output follows a scripted sequence. */
function plannerProvider(structuredSeq: unknown[]): { provider: BrainProvider; generate: ReturnType<typeof vi.fn> } {
  let i = 0;
  const generate = vi.fn(async (): Promise<BrainOutput> => {
    const structured = structuredSeq[Math.min(i, structuredSeq.length - 1)];
    i += 1;
    return { structured } as unknown as BrainOutput;
  });
  return { provider: { providerName: "mock", generate }, generate };
}

describe("planAgentTurn — self-correction retry (openclaw error-as-signal)", () => {
  it("retries once after a malformed structured output, then routes by the model", async () => {
    const { provider, generate } = plannerProvider([
      {}, // first attempt: no intent → parse miss
      { intent: "chat", requiresConfirmation: false }, // retry: valid
    ]);

    const planning = await planAgentTurn({ message: "看看茅台现在怎么样" }, { brainProvider: provider });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(planning.routedBy).toBe("model");
    expect(planning.plan.intent).toBe("chat");
  });

  it("falls back to deterministic rules only after the bounded retries are exhausted", async () => {
    const { provider, generate } = plannerProvider([{}]); // always malformed

    const planning = await planAgentTurn({ message: "看看茅台现在怎么样" }, { brainProvider: provider });

    expect(generate).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(planning.routedBy).toBe("fallback");
  });
});
