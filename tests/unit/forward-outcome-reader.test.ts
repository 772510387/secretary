import { describe, expect, it } from "vitest";
import { ForwardOutcomeReader } from "../../src/app/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import {
  REPLAY_MARKET,
  REPLAY_SYMBOL,
  buildReplayBars,
  replayBarsBySymbol,
} from "../fixtures/replay/fixtures.js";

const target = { symbol: REPLAY_SYMBOL, market: REPLAY_MARKET };

function makeReader(): ForwardOutcomeReader {
  return new ForwardOutcomeReader(new FixtureHistoryProvider(replayBarsBySymbol()));
}

describe("ForwardOutcomeReader (fenced look-ahead)", () => {
  it("returns the realized close N trading days after fromDate", async () => {
    const bars = buildReplayBars();
    const fromClose = bars.find((bar) => bar.tradeDate === "2026-06-17")!.close;

    const outcome = await makeReader().getForwardOutcome({
      symbol: target,
      fromDate: "2026-06-17",
      fromClose,
      horizonTradingDays: 2,
    });

    expect(outcome.realized).toBe(true);
    expect(outcome.toDate).toBe("2026-06-19"); // 2 trading days after 06-17: 06-18, 06-19
    const toClose = bars.find((bar) => bar.tradeDate === "2026-06-19")!.close;
    expect(outcome.toClose).toBe(toClose);
    const expectedReturn = Math.round(((toClose - fromClose) / fromClose) * 1_000_000) / 1_000_000;
    expect(outcome.forwardReturn).toBe(expectedReturn);
  });

  it("reads only bars strictly after fromDate (excludes the anchor bar)", async () => {
    const outcome = await makeReader().getForwardOutcome({
      symbol: target,
      fromDate: "2026-06-18",
      fromClose: 10,
      horizonTradingDays: 1,
    });
    expect(outcome.toDate).toBe("2026-06-19");
    expect(outcome.toDate! > "2026-06-18").toBe(true);
  });

  it("is unrealized (null score) when not enough forward bars exist yet", async () => {
    const outcome = await makeReader().getForwardOutcome({
      symbol: target,
      fromDate: "2026-06-22", // last fixture bar — nothing after it
      fromClose: 13.5,
      horizonTradingDays: 3,
    });
    expect(outcome.realized).toBe(false);
    expect(outcome.toDate).toBeNull();
    expect(outcome.forwardReturn).toBeNull();
  });

  it("is unrealized when fromClose is non-positive (no valid denominator)", async () => {
    const outcome = await makeReader().getForwardOutcome({
      symbol: target,
      fromDate: "2026-06-17",
      fromClose: 0,
      horizonTradingDays: 1,
    });
    expect(outcome.realized).toBe(false);
  });
});
