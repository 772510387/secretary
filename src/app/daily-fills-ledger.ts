import { type AppConfig } from "../config/index.js";
import { roundMoney, type TradeRecord } from "../domain/portfolio/index.js";
import { PaperBroker } from "../infrastructure/broker/index.js";

export interface DailyFillsLedger {
  tradingDate: string;
  count: number;
  buyCount: number;
  sellCount: number;
  buyAmount: number;
  sellAmount: number;
  /** Human-readable 当日成交账单 block for the evening-review wake prompt. */
  rendered: string;
}

/**
 * MEM-03: build the day's actual trade bill from the persisted trades, so the evening
 * review is fed the real fills instead of the model guessing what it traded. Pure and
 * deterministic over the input trades.
 */
export function buildDailyFillsLedger(
  trades: readonly TradeRecord[],
  tradingDate: string,
): DailyFillsLedger {
  const today = trades.filter((trade) => trade.tradeDate === tradingDate);
  const buys = today.filter((trade) => trade.side === "BUY");
  const sells = today.filter((trade) => trade.side === "SELL");
  const buyAmount = roundMoney(buys.reduce((sum, trade) => sum + trade.netAmount, 0));
  const sellAmount = roundMoney(sells.reduce((sum, trade) => sum + trade.netAmount, 0));

  const rendered =
    today.length === 0
      ? `【今日成交账单】${tradingDate}：无成交。`
      : [
          `【今日成交账单】${tradingDate}：共 ${today.length} 笔（买入 ${buys.length} 笔 ${buyAmount} 元、卖出 ${sells.length} 笔 ${sellAmount} 元）。`,
          ...today.map(
            (trade) => `- ${trade.side} ${trade.symbol} ${trade.quantity}股 @${trade.price}（净额 ${trade.netAmount}）`,
          ),
        ].join("\n");

  return {
    tradingDate,
    count: today.length,
    buyCount: buys.length,
    sellCount: sells.length,
    buyAmount,
    sellAmount,
    rendered,
  };
}

/** Thin reader: load persisted trades and build the day's ledger. Returns null on any read error. */
export function readDailyFillsLedger(input: {
  config: AppConfig;
  memoryDir: string;
  tradingDate: string;
}): DailyFillsLedger | null {
  try {
    const broker = new PaperBroker({
      memoryDir: input.memoryDir,
      t1Enabled: input.config.trading.t1Enabled,
    });
    return buildDailyFillsLedger(broker.getTrades(), input.tradingDate);
  } catch {
    return null;
  }
}
