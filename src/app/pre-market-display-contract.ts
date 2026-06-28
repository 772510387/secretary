import type { CerebellumAlarmType } from "../domain/cerebellum/index.js";

const PRE_MARKET_DISPLAY_CONTRACT = [
  "【盘前市场背景呈现】这是 08:30 盘前计划/早盘观点，summary 开头必须先给老板一个类似 docs/display/pre-market.md 的“市场背景”块。",
  "固定结构：",
  "📅 <北京时间日期> 市场背景",
  "大盘情况",
  "- 指数：逐项列出已提供指数的点位与涨跌幅；指数缺失就写“指数数据缺失”，不得编。",
  "- 市场宽度：列出涨停/跌停/上涨/下跌/热度；缺字段写“数据缺失”。",
  "- 成交额：优先引用观察池概览里的“全市场成交额/放量/缩量”；没有就写“成交额同比缺失”。",
  "热点板块",
  "1. 只引用观察池概览中的板块涨幅榜、热门题材、热门板块龙头，或联网检索里有来源的政策/新闻；缺则写“板块热度数据缺失”。",
  "连板股",
  "- 引用观察池概览里的“N连板/涨停/昨日涨停/封单/一字板”标记；没有明确连板天数就写“连板梯队数据缺失或首板为主”，禁止自造连板名单。",
  "市场背景之后再继续给剑盾双修、操作汇报和模拟盘建议。",
].join("\n");

export function isPreMarketDisplayNode(alarmType: CerebellumAlarmType | undefined): boolean {
  return alarmType === "pre_market_plan";
}

export function buildPreMarketDisplayContract(): string {
  return PRE_MARKET_DISPLAY_CONTRACT;
}
