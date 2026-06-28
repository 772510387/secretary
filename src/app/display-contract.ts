import type { CerebellumAlarmType } from "../domain/cerebellum/index.js";
import {
  buildPreMarketDisplayContract,
  isPreMarketDisplayNode,
} from "./pre-market-display-contract.js";

/**
 * Display contracts make the Feishu output match the depth/shape of the samples in
 * `docs/display/*`. They are *presentation* contracts: the deterministic facts are
 * still computed in code and injected as context; these strings only tell the brain
 * how to ORGANISE that context into the report skeleton the samples demonstrate.
 *
 * Two layers:
 *  - {@link FEISHU_PERSONA_CONTRACT}: shared persona + format + honesty markers, applied to
 *    every Feishu-facing report (proactive push and reactive Q&A).
 *  - {@link buildNodeDisplayContract}: the per-alarm-node skeleton (观察→判断→下次复查→Boss摘要,
 *    pre-market 市场背景, 竞价三指标, 盘后复盘, 周/月/年复盘).
 */

/** Shared persona + format + honesty contract for every Feishu-facing report. */
export const FEISHU_PERSONA_CONTRACT = [
  "【飞书呈现风格·必读】你是老板的 A 股模拟盘助理“小蜜”，对老板用敬语、口吻干练专业。",
  "- 分节清晰：用带 emoji 的小标题分节，关键个股/数字用要点列表或表格罗列，不要写成一大段。",
  "- 状态标记：用 🟢/🟡/🔴 标强弱或风险等级，用 ✅/⚠️ 标已执行/需注意。",
  "- 诚实标记：任何缺失或无法确认的事实，必须显式写“数据缺失/未记录/未确认”，严禁用记忆或常识编造指数、价格、连板、封单、题材、资金或盈亏。",
  "- 结尾固定用一行“🍯 Boss 摘要：”收口，给出最重要的结论或下一步动作。",
].join("\n");

/** 盘中必报/复盘节点的“观察→判断→下次复查→Boss摘要”骨架（对齐 docs/display/expectation-display.md）。 */
const INTRADAY_REVIEW_SKELETON = [
  "【盘中节点呈现】请按以下固定骨架组织 summary，每节都要写实，不许空泛：",
  "📊 观察：大盘点位与涨跌幅、涨跌家数、成交额、领涨/领跌板块、持仓表现、观察池异动（全部引用已提供的确定性数据，缺则写“数据缺失”）。",
  "🧭 判断：基于观察给出大盘情绪、主线确认/切换、持仓股研判、机会研判（这是你的强判断，可推演，但不得编造事实数字）。",
  "🗡️🛡️ 策略：剑(进攻：值得关注的标的与建议买入价，仅模拟盘建议)与盾(防守：持仓止盈/止损位、优先防守对象)。",
  "⏰ 下次复查：写明下一次复查时间点与 2-3 个重点跟踪项。",
].join("\n");

/** 9:15/9:25 竞价节点额外要求的“一字板 / 题材 / 封单”三指标列表（对齐 docs/display/alarm-operation.md 末尾要求）。 */
const CALL_AUCTION_EXTRA = [
  "【竞价三指标列表·必给】除盘面判断外，必须额外给出三个列表（每项尽量给代码+名称，数据缺失则明确写“暂无竞价封板数据/降级”，不得编造）：",
  "1. 🧊 竞价一字板：列出竞价即一字封板的标的（引用观察池概览中的“一字板”标记）。",
  "2. 🔥 走的题材：列出竞价走强的题材/板块及其代表标的（引用观察池概览板块与题材热度）。",
  "3. 💰 封单榜：按封单额从大到小列出封板标的（引用观察池概览中的“封单”标记/金额）；封单额缺失就写“封单额未获取”。",
].join("\n");

/** 盘后/晚间复盘节点的深度骨架（对齐 docs/display/expectation-display.md 收盘复盘 与 trading-day-review.md）。 */
const EVENING_REVIEW_SKELETON = [
  "【盘后复盘呈现】请按以下结构组织 summary，数字全部引用已提供的账本/快照/成交，缺则写“未记录”：",
  "💰 最终战绩：期初资产、期末资产、当日盈亏与收益率。",
  "📈 操作统计：买入/卖出次数、股数、成交额、最终持仓。",
  "🎯 关键决策复盘：逐笔列出时间(北京时间)、操作、价格、理由、盈亏。",
  "💡 策略亮点 / ⚠️ 可改进：各 2-3 条。",
  "🧠 知识沉淀：一句话经验或可复用的策略命中/失效。",
  "📋 明日计划：观察重点与待办。",
].join("\n");

/** 周/月/年复盘节点的骨架（对齐 docs/display/daily-alarm-list.md 周末/月度/年度任务）。 */
const PERIOD_REVIEW_SKELETON = [
  "【周期复盘呈现】请按机构级复盘组织 summary：本期收益与胜率/盈亏比/最大回撤(有数据才给，缺则写“未统计”)、核心主线板块、典型成功与失败案例、下期策略与重点观察方向。",
].join("\n");

const INTRADAY_REVIEW_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "morning_review",
  "midday_review",
  "afternoon_risk_scan",
  "late_session_plan",
  "closing_snapshot",
]);

const CALL_AUCTION_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "call_auction_watch",
  "pre_open_confirmation",
]);

const EVENING_REVIEW_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "post_close_review",
  "deep_review",
  "next_day_watchlist",
  "daily_reflection",
]);

const PERIOD_REVIEW_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "weekly_review",
  "monthly_review",
  "yearly_review",
  "weekend_morning_brief",
  "weekly_knowledge_absorb",
  "weekly_live_report",
  "weekly_winrate_review",
]);

/**
 * Returns the display skeleton for an alarm node, or undefined for nodes that need
 * only the shared persona (e.g. data_warmup). Pre-market nodes delegate to the
 * existing pre-market contract so its wording (and its tests) stay intact; the two
 * call-auction nodes additionally get the 一字板/题材/封单 three-list requirement.
 */
export function buildNodeDisplayContract(
  alarmType: CerebellumAlarmType | undefined,
): string | undefined {
  if (alarmType === undefined) {
    return undefined;
  }

  if (isPreMarketDisplayNode(alarmType)) {
    return buildPreMarketDisplayContract();
  }

  if (CALL_AUCTION_NODES.has(alarmType)) {
    return [buildPreMarketDisplayContract(), CALL_AUCTION_EXTRA].join("\n");
  }

  if (INTRADAY_REVIEW_NODES.has(alarmType)) {
    return INTRADAY_REVIEW_SKELETON;
  }

  if (EVENING_REVIEW_NODES.has(alarmType)) {
    return EVENING_REVIEW_SKELETON;
  }

  if (PERIOD_REVIEW_NODES.has(alarmType)) {
    return PERIOD_REVIEW_SKELETON;
  }

  return undefined;
}
