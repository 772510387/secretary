import { describe, expect, it } from "vitest";
import {
  buildPaperAgentTools,
  inferMarket,
  type PaperAgentToolDeps,
  type PaperOrderOutcome,
  type PaperPortfolioView,
} from "../../src/app/index.js";
import type { AgentToolCall } from "../../src/domain/brain/index.js";

const portfolio: PaperPortfolioView = {
  accountId: "paper-1",
  availableCash: 100_000,
  totalCash: 100_000,
  totalAssets: 100_000,
  totalPositionMarketValue: 0,
  totalUnrealizedPnl: 0,
  investedRatio: 0,
  positions: [],
  pricesAvailable: true,
  asOf: "2026-06-24T01:00:00.000Z",
};

function call(name: string, args: Record<string, unknown>): AgentToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

function baseDeps(overrides: Partial<PaperAgentToolDeps> = {}): PaperAgentToolDeps {
  return {
    loadPortfolio: () => portfolio,
    executePaperOrder: (): PaperOrderOutcome => ({ status: "filled", quantity: 100, limitPrice: 10 }),
    ...overrides,
  };
}

describe("buildPaperAgentTools", () => {
  it("hides get_quote/get_technicals when their deps are not provided", () => {
    const tools = buildPaperAgentTools(baseDeps());
    const names = tools.specs.map((spec) => spec.name);
    expect(names).toContain("get_portfolio");
    expect(names).toContain("paper_buy");
    expect(names).toContain("paper_sell");
    expect(names).not.toContain("get_quote");
    expect(names).not.toContain("get_technicals");
  });

  it("exposes read tools when their deps exist", () => {
    const tools = buildPaperAgentTools(
      baseDeps({
        getQuote: () => ({ symbol: "600519", price: 1700 }),
        getTechnicals: () => ({
          symbol: "600519",
          market: "SSE",
          asOfDate: "2026-06-23",
          trend: "up",
          high60: 1800,
          low60: 1500,
          rangePosition60: 0.6,
        }),
      }),
    );
    const names = tools.specs.map((spec) => spec.name);
    expect(names).toContain("get_quote");
    expect(names).toContain("get_technicals");
  });

  it("get_portfolio returns the account view", async () => {
    const tools = buildPaperAgentTools(baseDeps());
    const result = await tools.execute(call("get_portfolio", {}));
    const parsed = JSON.parse(result.content) as { ok: boolean; portfolio: { accountId: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.portfolio.accountId).toBe("paper-1");
  });

  it("paper_buy records a mutated effect on a fill and infers the market", async () => {
    let received: { market: string } | undefined;
    const tools = buildPaperAgentTools(
      baseDeps({
        executePaperOrder: (order) => {
          received = { market: order.market };
          return { status: "filled", quantity: 100, limitPrice: 1700 };
        },
      }),
    );

    const result = await tools.execute(call("paper_buy", { symbol: "600519", reason: "突破年线" }));

    expect(received?.market).toBe("SSE");
    expect(result.effect?.kind).toBe("paper_buy");
    expect(result.effect?.mutated).toBe(true);
    expect(result.effect?.summary).toContain("买入 600519");
    expect(result.effect?.summary).toContain("突破年线");
  });

  it("a blocked order is reported but NOT counted as a mutation", async () => {
    const tools = buildPaperAgentTools(
      baseDeps({ executePaperOrder: () => ({ status: "blocked", reason: "risk:max_single_position" }) }),
    );
    const result = await tools.execute(call("paper_buy", { symbol: "000001", reason: "试一下" }));

    expect(result.effect?.mutated).toBe(false);
    expect(result.effect?.summary).toContain("被风控拦截");
  });

  it("an idempotent re-fill is not counted as a fresh mutation", async () => {
    const tools = buildPaperAgentTools(
      baseDeps({ executePaperOrder: () => ({ status: "filled", quantity: 100, limitPrice: 10, idempotent: true }) }),
    );
    const result = await tools.execute(call("paper_sell", { symbol: "600519", reason: "止盈" }));
    expect(result.effect?.mutated).toBe(false);
  });

  it("rejects an invalid symbol with a tool error", async () => {
    const tools = buildPaperAgentTools(baseDeps());
    const result = await tools.execute(call("paper_buy", { symbol: "ABC", reason: "x" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("参数校验失败");
  });

  it("get_quote reports missing data instead of inventing a price", async () => {
    const tools = buildPaperAgentTools(baseDeps({ getQuote: () => null }));
    const result = await tools.execute(call("get_quote", { symbol: "600519" }));
    const parsed = JSON.parse(result.content) as { found: boolean };
    expect(parsed.found).toBe(false);
  });

  it("hides memory tools unless their deps are provided (MEM-05/07)", () => {
    const names = buildPaperAgentTools(baseDeps()).specs.map((spec) => spec.name);
    expect(names).not.toContain("search_memory");
    expect(names).not.toContain("remember");

    const withMemory = buildPaperAgentTools(
      baseDeps({
        searchMemory: () => ({ count: 0, hits: [] }),
        rememberNote: () => ({ ok: true, path: "x" }),
      }),
    ).specs.map((spec) => spec.name);
    expect(withMemory).toContain("search_memory");
    expect(withMemory).toContain("remember");
  });

  it("remember writes a note but is NOT a tradeable mutation", async () => {
    let received: { note: string } | undefined;
    const tools = buildPaperAgentTools(
      baseDeps({
        rememberNote: (note) => {
          received = { note: note.note };
          return { ok: true, path: "memory/long_term/2026-06/model-notes.md" };
        },
      }),
    );
    const result = await tools.execute(call("remember", { note: "银行股护盘有效", kind: "lesson" }));
    expect(received?.note).toBe("银行股护盘有效");
    expect(result.effect?.kind).toBe("memory_write");
    expect(result.effect?.mutated).toBe(false); // never poses as a trade in the ops push
    expect(JSON.parse(result.content).ok).toBe(true);
  });

  it("search_memory returns hits read-only", async () => {
    const tools = buildPaperAgentTools(
      baseDeps({
        searchMemory: () => ({
          count: 1,
          hits: [{ path: "long_term/2026-06/x.md", snippet: "大盘跳水买银行股", updatedAt: "2026-06-20T00:00:00.000Z", matchCount: 2 }],
        }),
      }),
    );
    const result = await tools.execute(call("search_memory", { query: "大盘跳水" }));
    const parsed = JSON.parse(result.content) as { ok: boolean; count: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
    expect(result.effect).toBeUndefined(); // read-only: no effect
  });
});

describe("inferMarket", () => {
  it("maps 6/9/5 to SSE and the rest to SZSE", () => {
    expect(inferMarket("600519")).toBe("SSE");
    expect(inferMarket("900001")).toBe("SSE");
    expect(inferMarket("000001")).toBe("SZSE");
    expect(inferMarket("300750")).toBe("SZSE");
  });
});
