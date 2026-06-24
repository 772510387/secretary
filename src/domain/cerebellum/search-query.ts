import type { CerebellumAlarmType } from "./schemas.js";

/**
 * Deterministic per-node web-search query builder (眼).
 *
 * The bug this fixes: the daemon used to pass the raw alarm-type string (e.g.
 * "overnight_digest") straight to Tavily, which is a semantic void — the search
 * engine returned unrelated results (famously, molecular-biology papers for
 * "overnight digest"). A search query is fixed, deterministic backend work; it
 * must NOT be left to a label or to the model. This maps each alarm node to a real,
 * A-share-focused Chinese query so the brain is fed relevant news/policy, not noise.
 */
export function buildNodeSearchQuery(alarmType: CerebellumAlarmType, date: string): string {
  const day = (date ?? "").slice(0, 10);
  const builder = NODE_QUERY[alarmType] ?? defaultQuery;
  return `${builder(day)}`.replace(/\s+/g, " ").trim().slice(0, 200);
}

function defaultQuery(day: string): string {
  return `A股 大盘行情 板块异动 资金流向 政策消息 ${day}`;
}

const NODE_QUERY: Partial<Record<CerebellumAlarmType, (day: string) => string>> = {
  data_warmup: (d) => `A股 今日交易日 开市安排 涨跌停 重要财经事件 ${d}`,
  overnight_digest: (d) =>
    `A股 隔夜 美股 纳斯达克 中概股 富时中国A50 外盘 重要政策 利好利空 财经新闻 ${d}`,
  pre_market_plan: (d) => `A股 今日策略 主线题材 热点板块 龙头股 机构观点 ${d}`,
  call_auction_watch: (d) => `A股 集合竞价 涨停 一字板 连板 情绪 高开 ${d}`,
  pre_open_confirmation: (d) => `A股 开盘 主力资金 北向资金 早盘 风险提示 ${d}`,
  morning_review: (d) => `A股 早盘 成交量 领涨板块 题材 强势股 ${d}`,
  midday_review: (d) => `A股 午盘 上午行情 板块轮动 资金 午后展望 ${d}`,
  afternoon_risk_scan: (d) => `A股 午后 跳水风险 高位股 炸板 资金出逃 ${d}`,
  late_session_plan: (d) => `A股 尾盘 资金抢筹 明日预期 板块 龙头 ${d}`,
  closing_snapshot: (d) => `A股 收盘 涨跌幅 成交额 北向资金 ${d}`,
  closing_review: (d) => `A股 收盘 复盘 主线板块 涨停分析 资金流向 ${d}`,
  post_close_review: (d) => `A股 盘后 龙虎榜 机构 游资 资金真实流向 重要公告 ${d}`,
  deep_review: (d) => `A股 盘后深度复盘 行业基本面 个股研报 风险 ${d}`,
  next_day_watchlist: (d) => `A股 明日 潜力题材 热点预期 关注个股 ${d}`,
  daily_reflection: (d) => `A股 今日总结 市场情绪 操作得失 经验教训 ${d}`,
  weekly_review: (d) => `A股 本周 周线 主线 资金 下周策略 ${d}`,
  monthly_review: (d) => `A股 本月 月度 行情回顾 风格切换 ${d}`,
  yearly_review: (d) => `A股 年度 行情回顾 主线 风格 明年展望 ${d}`,
};
