import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import {
  PaperExecutionError,
  buildInitialPaperAccountSeed,
  executePaperStopLoss,
  executePendingOrder,
} from "../../src/app/index.js";
import {
  createPortfolioMemoryPaths,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";
import { PaperBroker } from "../../src/infrastructure/broker/index.js";
import {
  tradeIntentReviewProposalSchema,
  type TradeIntentReviewProposal,
} from "../../src/domain/memory/index.js";

const NOW = "2026-06-22T07:30:00.000Z";

// Force a strictly-paper config regardless of the local .env.
const PAPER_CONFIG: AppConfig = (() => {
  const config = loadConfig();
  return {
    ...config,
    runtime: { ...config.runtime, liveTrading: false },
    trading: { ...config.trading, mode: "paper" },
    broker: { ...config.broker, provider: "paper" },
  };
})();

const tmpRoots: string[] = [];
function seededPaperDir(initialCash = 20000): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "funnel-exec-"));
  tmpRoots.push(root);
  const memoryDir = path.join(root, "memory");
  initializePaperAccountMemory({
    memoryDir,
    seed: buildInitialPaperAccountSeed({ initialCash }),
    reset: true,
    dryRun: false,
  });
  return memoryDir;
}

function proposal(
  side: "BUY" | "SELL" | "HOLD" | "WATCH",
  symbol = "000001",
  overrides: Partial<TradeIntentReviewProposal> = {},
): TradeIntentReviewProposal {
  return tradeIntentReviewProposalSchema.parse({
    proposalId: `funnelprop-paper-main-${symbol}-${side}`,
    proposalType: "trade_intent_review",
    status: "pending_review",
    source: { sourceType: "brain_tool_request", requestId: "funnel-select-1", toolType: "propose_trade_intent" },
    symbol,
    market: "SZSE",
    name: "平安银行",
    side,
    currency: "CNY",
    rationale: "测试候选",
    reviewReason: "测试",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: { type: "system", id: "funnel-selector" },
    ...overrides,
  });
}

function broker(memoryDir: string): PaperBroker {
  return new PaperBroker({ memoryDir, t1Enabled: PAPER_CONFIG.trading.t1Enabled });
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup (Windows can hold transient handles)
    }
  }
});

describe("executePendingOrder — hard paper-only gate (RED LINE)", () => {
  it("refuses when live trading is enabled", () => {
    const memoryDir = seededPaperDir();
    const config: AppConfig = { ...PAPER_CONFIG, runtime: { ...PAPER_CONFIG.runtime, liveTrading: true } };
    expect(() =>
      executePendingOrder({ proposal: proposal("BUY"), latestPrice: 13, reviewer: "auto-paper" }, { config, memoryDir }),
    ).toThrow(PaperExecutionError);
  });

  it("refuses a non-paper trading mode or broker provider", () => {
    const memoryDir = seededPaperDir();
    expect(() =>
      executePendingOrder(
        { proposal: proposal("BUY"), latestPrice: 13, reviewer: "auto-paper" },
        { config: { ...PAPER_CONFIG, trading: { ...PAPER_CONFIG.trading, mode: "live" } }, memoryDir },
      ),
    ).toThrow(PaperExecutionError);
    expect(() =>
      executePendingOrder(
        { proposal: proposal("BUY"), latestPrice: 13, reviewer: "auto-paper" },
        { config: { ...PAPER_CONFIG, broker: { ...PAPER_CONFIG.broker, provider: "readonly" } }, memoryDir },
      ),
    ).toThrow(PaperExecutionError);
  });
});

describe("executePendingOrder — paper fill", () => {
  it("fills a BUY on an empty paper account, sized within the single-position cap", () => {
    const memoryDir = seededPaperDir(20000);
    const result = executePendingOrder(
      { proposal: proposal("BUY"), latestPrice: 13, reviewer: "user" },
      { config: PAPER_CONFIG, memoryDir },
    );
    expect(result.status).toBe("filled");
    expect(result.quantity! % 100).toBe(0);
    expect(result.quantity! * 13).toBeLessThanOrEqual(20000 * PAPER_CONFIG.risk.maxSinglePositionRatio + 1e-6);
    expect(broker(memoryDir).getPositions().some((p) => p.symbol === "000001")).toBe(true);
  });

  it("uses backend pre-sized quantity and limit price when the proposal carries them", () => {
    const memoryDir = seededPaperDir(20000);
    const result = executePendingOrder(
      {
        proposal: proposal("BUY", "000001", { quantity: 100, limitPrice: 13 }),
        latestPrice: 99,
        reviewer: "auto-paper",
      },
      { config: PAPER_CONFIG, memoryDir },
    );

    expect(result.status).toBe("filled");
    expect(result.quantity).toBe(100);
    expect(result.limitPrice).toBe(13);
    const filled = broker(memoryDir).getPositions().find((p) => p.symbol === "000001");
    expect(filled?.quantity).toBe(100);
    expect(filled?.costPrice).toBe(13);
  });

  it("is idempotent — re-executing the same proposal does not double-fill", () => {
    const memoryDir = seededPaperDir(20000);
    const p = proposal("BUY");
    executePendingOrder({ proposal: p, latestPrice: 13, reviewer: "user" }, { config: PAPER_CONFIG, memoryDir });
    const afterFirst = broker(memoryDir).getPositions().find((x) => x.symbol === "000001")?.quantity;

    const second = executePendingOrder(
      { proposal: p, latestPrice: 13, reviewer: "user" },
      { config: PAPER_CONFIG, memoryDir },
    );
    const afterSecond = broker(memoryDir).getPositions().find((x) => x.symbol === "000001")?.quantity;

    expect(second.idempotent).toBe(true);
    expect(afterSecond).toBe(afterFirst);
  });

  it("skips an unsupported side (HOLD / WATCH)", () => {
    const memoryDir = seededPaperDir();
    const result = executePendingOrder(
      { proposal: proposal("HOLD"), latestPrice: 13, reviewer: "user" },
      { config: PAPER_CONFIG, memoryDir },
    );
    expect(result.status).toBe("skipped");
  });
});

describe("executePaperStopLoss — 8% 硬止损强制平仓 (RED LINE, paper only)", () => {
  const STOP_NOW = new Date("2026-06-22T06:00:00.000Z");

  // A SETTLED holding (bought a prior day): availableQuantity = quantity, no T+1 block —
  // exactly what the 3-second sentinel sees when a position breaks the 8% stop line.
  function seedSettledHolding(memoryDir: string, quantity = 600): void {
    const accountId = new PaperBroker({ memoryDir, t1Enabled: true }).getAccount().accountId;
    const positionsPath = createPortfolioMemoryPaths(memoryDir).positionsPath;
    writeFileSync(
      positionsPath,
      JSON.stringify(
        [
          {
            accountId,
            symbol: "000001",
            market: "SZSE",
            name: "平安银行",
            quantity,
            availableQuantity: quantity,
            todayBuyQuantity: 0,
            frozenQuantity: 0,
            costPrice: 13,
            latestPrice: 13,
            currency: "CNY",
            openedAt: "2026-06-19T01:30:00.000Z",
            updatedAt: "2026-06-19T07:00:00.000Z",
          },
        ],
        null,
        2,
      ),
    );
  }

  it("force-closes the full sellable quantity in paper, idempotently within a day", () => {
    const memoryDir = seededPaperDir(20000);
    seedSettledHolding(memoryDir, 600);

    const close = executePaperStopLoss(
      { symbol: "000001", market: "SZSE", name: "平安银行", latestPrice: 11, now: STOP_NOW },
      { config: PAPER_CONFIG, memoryDir },
    );
    expect(close.status).toBe("filled");
    expect(close.quantity).toBe(600);
    expect(
      new PaperBroker({ memoryDir, t1Enabled: true }).getPositions().some((p) => p.symbol === "000001" && p.quantity > 0),
    ).toBe(false);

    const again = executePaperStopLoss(
      { symbol: "000001", market: "SZSE", latestPrice: 11, now: STOP_NOW },
      { config: PAPER_CONFIG, memoryDir },
    );
    expect(again.idempotent).toBe(true);
  });

  it("force-closes an odd-lot sellable remainder instead of applying the BUY lot rule", () => {
    const memoryDir = seededPaperDir(20000);
    seedSettledHolding(memoryDir, 50);

    const close = executePaperStopLoss(
      { symbol: "000001", market: "SZSE", name: "平安银行", latestPrice: 11, now: STOP_NOW },
      { config: PAPER_CONFIG, memoryDir },
    );

    expect(close.status).toBe("filled");
    expect(close.quantity).toBe(50);
  });

  it("refuses on a live/non-paper config (never auto-closes live)", () => {
    const memoryDir = seededPaperDir();
    seedSettledHolding(memoryDir, 600);
    expect(() =>
      executePaperStopLoss(
        { symbol: "000001", market: "SZSE", latestPrice: 11, now: STOP_NOW },
        { config: { ...PAPER_CONFIG, runtime: { ...PAPER_CONFIG.runtime, liveTrading: true } }, memoryDir },
      ),
    ).toThrow(PaperExecutionError);
  });

  it("skips when nothing is sellable (no holding)", () => {
    const memoryDir = seededPaperDir();
    const result = executePaperStopLoss(
      { symbol: "000001", market: "SZSE", latestPrice: 11, now: STOP_NOW },
      { config: PAPER_CONFIG, memoryDir },
    );
    expect(result.status).toBe("skipped");
  });
});
