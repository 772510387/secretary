import {
  calculatePortfolioValuation,
  type Account,
  type Position,
} from "../domain/portfolio/index.js";

/**
 * Deterministic fast-path for paper-account STATUS queries.
 *
 * "当前模拟盘信息/账户/持仓/资产/现金/仓位/盈亏" is a pure data lookup — it must NOT be
 * routed through the model (router LLM call + networked context build + a blocking
 * analysis call that can time out). This reads the stored account/positions and
 * formats them deterministically: instant, no network, no hallucination. Aligns with
 * the first principle 凡是确定的归于代码.
 *
 * Conservative on purpose: a query that also asks to ANALYZE / trade / replay falls
 * through to the model path. Only a plain status lookup short-circuits here.
 */
const STATUS_NOUN =
  /模拟盘(信息|情况|状态|概况|账户)?|账户(信息|情况|状态|余额|概况)?|持仓(信息|情况|明细|列表|概况|有哪些|是什么)?|资产|总资产|余额|可用(现金|资金)|现金|仓位|市值|盈亏|浮盈|浮亏|净值|赚了多少|亏了多少|盈利多少|多少钱|账本/;
const ANALYSIS_VERB =
  /分析|研判|建议|怎么操作|怎么看|看法|要不要|能不能|该买|该卖|买入|卖出|加仓|减仓|调仓|止盈|止损|趋势|走势|预测|后市|题材|板块|新闻|政策|大盘|复盘|风险/;
const ACTION_VERB = /重演|补跑|重放|回放|复现|清空|重置|构建|新建|初始化/;

/** True when the message is a plain account-status lookup answerable without the model. */
export function detectPortfolioStatusQuery(message: string): boolean {
  const text = message.trim();
  if (!text) {
    return false;
  }
  return STATUS_NOUN.test(text) && !ANALYSIS_VERB.test(text) && !ACTION_VERB.test(text);
}

export interface FormatPortfolioStatusInput {
  account: Account;
  positions: Position[];
  /** Optional fresh prices; when omitted the stored position.latestPrice is used. */
  prices?: Record<string, number>;
  t1Enabled?: boolean;
}

/** Renders a deterministic, human-readable paper-account summary (no model). */
export function formatPortfolioStatus(input: FormatPortfolioStatusInput): string {
  const valuation = calculatePortfolioValuation(input.account, input.positions, {
    prices: input.prices,
    t1Enabled: input.t1Enabled ?? true,
  });
  const pnlRatio = valuation.totalCostBasis > 0 ? valuation.totalUnrealizedPnl / valuation.totalCostBasis : 0;

  const lines = [
    "【模拟盘账户概况】",
    `总资产 ¥${group(valuation.totalAssets)} | 可用现金 ¥${group(valuation.cash.available)} | 持仓市值 ¥${group(valuation.totalPositionMarketValue)}`,
    `仓位 ${pct(valuation.investedRatio)} | 总浮动盈亏 ¥${signedMoney(valuation.totalUnrealizedPnl)}（${signedPct(pnlRatio)}）`,
  ];

  if (valuation.cash.frozen > 0) {
    lines.push(`冻结现金 ¥${group(valuation.cash.frozen)}`);
  }

  if (valuation.positions.length === 0) {
    lines.push("当前空仓（无持仓）。");
  } else {
    lines.push(`持仓 ${valuation.positions.length} 只：`);
    valuation.positions.forEach((position, index) => {
      lines.push(
        `${index + 1}. ${position.name}(${position.symbol}) ${position.quantity}股(可卖${position.sellableQuantity}) ` +
          `成本${group(position.costPrice)} 现价${group(position.latestPrice)} 市值¥${group(position.marketValue)} ` +
          `盈亏¥${signedMoney(position.unrealizedPnl)}(${signedPct(position.unrealizedPnlRatio)}) 仓位${pct(position.positionRatio)}`,
      );
    });
  }

  lines.push("（现价取最近一次盯盘快照；模拟盘账本）");
  return lines.join("\n");
}

/** 2-decimal thousands-grouped money string, e.g. -1234.5 -> "-1,234.50". */
function group(value: number): string {
  const fixed = value.toFixed(2);
  const negative = fixed.startsWith("-");
  const [intPart, decPart] = (negative ? fixed.slice(1) : fixed).split(".");
  return `${negative ? "-" : ""}${intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decPart}`;
}

function signedMoney(value: number): string {
  return `${value >= 0 ? "+" : ""}${group(value)}`;
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`;
}

function signedPct(ratio: number): string {
  return `${ratio >= 0 ? "+" : ""}${(ratio * 100).toFixed(2)}%`;
}
