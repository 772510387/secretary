import { type AppConfig } from "../config/index.js";
import { PaperBroker } from "../infrastructure/broker/index.js";

export interface SettleDailyPositionsInput {
  config: AppConfig;
  memoryDir: string;
  /** Beijing trade date (YYYY-MM-DD) to settle the positions up to. */
  tradingDate: string;
}

export interface SettleDailyPositionsResult {
  /** How many positions had prior-day buys roll forward into available shares. */
  changed: number;
}

/**
 * HAND-02: run the T+1 cross-day settlement once for a trading date and persist the result.
 *
 * Buying locks shares as todayBuyQuantity (unsellable that day). Without a settlement step
 * those shares stayed locked forever, so paper holdings could never be sold. Calling this at
 * the start of a trading day (and the broker also auto-settles on every order) rolls prior-day
 * buys into availableQuantity. Pure backend, no model, no network; safe/idempotent to re-run.
 */
export function settleDailyPositions(input: SettleDailyPositionsInput): SettleDailyPositionsResult {
  try {
    const broker = new PaperBroker({
      memoryDir: input.memoryDir,
      t1Enabled: input.config.trading.t1Enabled,
    });
    const { changed } = broker.settleDailyT1(input.tradingDate);
    return { changed };
  } catch {
    // No account/positions yet (or unreadable) — nothing to settle.
    return { changed: 0 };
  }
}
