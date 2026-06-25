import { z } from "zod";
import { stockMarketSchema, stockSymbolSchema } from "../shared/index.js";
import { isLikelySTName } from "./screener.js";
import { isMainBoardSymbol } from "./symbols.js";

/**
 * 龙虎榜 (Dragon-Tiger list): one stock's end-of-day top-traders summary. Eastmoney
 * returns ONE ROW PER 上榜原因/席位, all sharing the SAME stock-level NET_BS_AMT — so
 * entries are deduped by code (never summed) with the distinct reasons collected.
 * `netBuyAmount` (主力净买入) is the headline signal: 资金抢筹 vs 出货 after the close.
 */
export const dragonTigerEntrySchema = z
  .object({
    tradeDate: z.string().trim().min(1),
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    closePrice: z.number().finite().nonnegative().optional(),
    changePct: z.number().finite().optional(),
    turnoverRate: z.number().finite().nonnegative().optional(),
    /** 龙虎榜净买入额 (yuan); positive = 净买入, negative = 净卖出. */
    netBuyAmount: z.number().finite(),
    buyAmount: z.number().finite().nonnegative().optional(),
    sellAmount: z.number().finite().nonnegative().optional(),
    /** 当日成交额 (yuan). */
    accumAmount: z.number().finite().nonnegative().optional(),
    reasons: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type DragonTigerEntry = z.infer<typeof dragonTigerEntrySchema>;

export interface DragonTigerSummary {
  date: string | null;
  /** Strongest 净买入 names (capital 抢筹), high → low. */
  topNetBuy: DragonTigerEntry[];
  /** Strongest 净卖出 names (capital 出货), most-negative first. */
  topNetSell: DragonTigerEntry[];
  /** How many entries survived the filter (main-board / non-ST). */
  count: number;
}

export interface SummarizeDragonTigerOptions {
  topN?: number;
  mainBoardOnly?: boolean;
  excludeST?: boolean;
}

/**
 * Filters to tradable main-board non-ST names and splits into 净买入榜 / 净卖出榜.
 * Pure + deterministic — same input, same output, symbols tie-break stably.
 */
export function summarizeDragonTiger(
  entries: readonly DragonTigerEntry[],
  options: SummarizeDragonTigerOptions = {},
): DragonTigerSummary {
  const topN = options.topN ?? 5;
  const mainBoardOnly = options.mainBoardOnly ?? true;
  const excludeST = options.excludeST ?? true;

  const filtered = entries.filter(
    (entry) =>
      (!mainBoardOnly || isMainBoardSymbol(entry.symbol)) &&
      (!excludeST || !isLikelySTName(entry.name)),
  );

  const topNetBuy = [...filtered]
    .filter((entry) => entry.netBuyAmount > 0)
    .sort((left, right) => right.netBuyAmount - left.netBuyAmount || left.symbol.localeCompare(right.symbol))
    .slice(0, topN);

  const topNetSell = [...filtered]
    .filter((entry) => entry.netBuyAmount < 0)
    .sort((left, right) => left.netBuyAmount - right.netBuyAmount || left.symbol.localeCompare(right.symbol))
    .slice(0, topN);

  return {
    date: filtered[0]?.tradeDate ?? null,
    topNetBuy,
    topNetSell,
    count: filtered.length,
  };
}

/** Renders the 龙虎榜 summary fed to the brain at 盘后 nodes. "" when nothing qualifies. */
export function renderDragonTigerSummary(summary: DragonTigerSummary): string {
  if (summary.count === 0) {
    return "";
  }
  const lines = [`【龙虎榜·盘后${summary.date ? ` ${summary.date}` : ""}】(主力净买卖，单位亿元)`];
  if (summary.topNetBuy.length > 0) {
    lines.push(`净买入前${summary.topNetBuy.length}：${summary.topNetBuy.map(formatEntry).join("、")}`);
  }
  if (summary.topNetSell.length > 0) {
    lines.push(`净卖出前${summary.topNetSell.length}：${summary.topNetSell.map(formatEntry).join("、")}`);
  }
  return lines.join("\n");
}

function formatEntry(entry: DragonTigerEntry): string {
  const change =
    entry.changePct === undefined ? "" : ` ${entry.changePct > 0 ? "+" : ""}${entry.changePct.toFixed(2)}%`;
  const yi = (entry.netBuyAmount / 1e8).toFixed(2);
  const net = entry.netBuyAmount >= 0 ? `净买+${yi}` : `净卖${yi}`;
  const reason = entry.reasons[0] ? `·${entry.reasons[0].slice(0, 14)}` : "";
  return `${entry.name}(${entry.symbol}${change} ${net}亿${reason})`;
}
