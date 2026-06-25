import { describe, expect, it, vi } from "vitest";
import {
  buildPaperAgentToolDeps,
  type PaperPortfolioView,
} from "../../src/app/index.js";
import type { AppConfig } from "../../src/config/index.js";
import type { ExecutePendingOrderInput, ExecutePendingOrderResult } from "../../src/app/execute-pending-order.js";

const config = {} as unknown as AppConfig;

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

describe("buildPaperAgentToolDeps", () => {
  it("turns a model buy intent into a review proposal and runs the deterministic hand", async () => {
    let captured: ExecutePendingOrderInput | undefined;
    const executeOrder = vi.fn((input: ExecutePendingOrderInput): ExecutePendingOrderResult => {
      captured = input;
      return { status: "filled", intentId: "i", quantity: 100, limitPrice: 1700 };
    });

    const deps = buildPaperAgentToolDeps({
      config,
      memoryDir: "/tmp/x",
      loadPortfolioView: () => portfolio,
      getLatestPrice: () => 1700,
      now: () => new Date("2026-06-24T01:00:00.000Z"),
      executeOrder,
    });

    const outcome = await deps.executePaperOrder({
      side: "BUY",
      symbol: "600519",
      market: "SSE",
      reason: "放量突破年线",
    });

    expect(outcome.status).toBe("filled");
    expect(outcome.quantity).toBe(100);
    expect(executeOrder).toHaveBeenCalledOnce();
    expect(captured?.reviewer).toBe("auto-paper");
    expect(captured?.proposal.side).toBe("BUY");
    expect(captured?.proposal.symbol).toBe("600519");
    expect(captured?.proposal.rationale).toBe("放量突破年线");
    // The model's intent must remain a non-executable, manual-review proposal object.
    expect(captured?.proposal.executionGuard.executable).toBe(false);
    expect(captured?.latestPrice).toBe(1700);
  });

  it("skips without calling the hand when there is no price", async () => {
    const executeOrder = vi.fn();
    const deps = buildPaperAgentToolDeps({
      config,
      memoryDir: "/tmp/x",
      loadPortfolioView: () => portfolio,
      getLatestPrice: () => null,
      executeOrder: executeOrder as never,
    });

    const outcome = await deps.executePaperOrder({ side: "BUY", symbol: "600519", market: "SSE", reason: "x" });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toBe("no_price");
    expect(executeOrder).not.toHaveBeenCalled();
  });

  it("prefers the model's limit price over the live price for sizing", async () => {
    let captured: ExecutePendingOrderInput | undefined;
    const deps = buildPaperAgentToolDeps({
      config,
      memoryDir: "/tmp/x",
      loadPortfolioView: () => portfolio,
      getLatestPrice: () => 999,
      executeOrder: (input): ExecutePendingOrderResult => {
        captured = input;
        return { status: "filled", intentId: "i", quantity: 100, limitPrice: 1680 };
      },
    });

    await deps.executePaperOrder({ side: "SELL", symbol: "600519", market: "SSE", limitPrice: 1680, reason: "止盈" });
    expect(captured?.latestPrice).toBe(1680);
  });
});
