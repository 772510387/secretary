import { type BrainProvider } from "../domain/brain/index.js";
import {
  buildCerebellumAlarmSopByType,
  renderCerebellumAlarmSop,
  resolveSopByAlarmType,
  type CerebellumAlarmType,
} from "../domain/cerebellum/index.js";
import {
  NOTIFICATION_SUMMARY_MAX_LENGTH,
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type { Account, Position } from "../domain/portfolio/index.js";
import {
  runAskOnce,
  type AskIndex,
  type AskTechnical,
  type AskWebSearchContext,
  type MarketDataHealth,
} from "./ask-portfolio.js";
import {
  buildNodeDisplayContract,
  FEISHU_PERSONA_CONTRACT,
} from "./display-contract.js";
import type { PlanWatchlistEntry } from "../domain/plan/index.js";
import type { ThemeHeatSummary } from "../domain/market/index.js";

export interface RunAlarmNodeInput {
  alarmType: CerebellumAlarmType;
  account: Account;
  positions?: Position[];
  prices?: Record<string, number>;
  technicals?: AskTechnical[];
  indices?: AskIndex[];
  watchlist?: PlanWatchlistEntry[];
  /** 观察池分类概览 (层级1 counts + 层级2 named picks) — injected so the push names categories. */
  poolOverview?: string;
  /** 日内检查点时间线 (上次→本次大盘/情绪变化) — injected for node-to-node continuity. */
  intradayTimeline?: string;
  /** 行情相位 label — injected so the brain reads 9:15 价 as 竞价价, not 开盘/盘中价. */
  marketPhase?: string;
  /** Data-provenance caveat (e.g. replay used today's live pool, not that day's history) — must be stated honestly, not hidden. */
  dataCaveat?: string;
  /** 龙虎榜 (主力净买卖) summary — injected at 盘后 nodes for capital-flow grounding. */
  dragonTiger?: string;
  /** 持仓资金面 (Sina 主力净流入 per held position) — injected for 盾/防守 grounding. */
  holdingsMoneyFlow?: string;
  themeHeat?: ThemeHeatSummary;
  dataHealth?: MarketDataHealth;
  webSearch?: AskWebSearchContext;
  /** 反哺: past lessons from long-term memory, prepended to the wake prompt (morning nodes). */
  priorKnowledge?: string;
  /** MEM-03: the day's actual trade bill (rendered), injected into evening review prompts. */
  todayFills?: string;
  now?: string;
}

/** Intraday/planning nodes that must answer in the 剑盾双修 (offense+defense) framework. */
const SWORD_SHIELD_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "pre_market_plan",
  "call_auction_watch",
  "morning_review",
  "midday_review",
  "afternoon_risk_scan",
  "late_session_plan",
  "closing_review",
]);

/** Morning news nodes that must assess overnight news impact PER held position. */
const HOLDING_IMPACT_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "overnight_digest", // 08:15 隔夜消息
  "pre_market_plan", // 08:30 晨报
]);

const SWORD_SHIELD_FRAMEWORK = [
  "请用【剑盾双修】框架作答，两个维度都必须给，不许泛泛而谈：",
  "盾(防守)：当前/各持仓的止盈位与止损位、大盘风险等级、优先防守哪只；",
  "剑(进攻)：今日主线板块与龙头、从100池里值得关注的标的、开仓条件与目标买入价(仅建议，不下单)。",
].join("\n");

/**
 * The push only renders the brain's `summary` field — `structured` is never shown
 * to the user. Without this contract the model leaves the detail in `structured`
 * and emits a one-paragraph abstract as `summary`, producing the empty-looking push.
 */
const PUSH_DELIVERY_CONTRACT = [
  "【推送约束·必读】你输出的 summary 字段是唯一会推送给老板的内容，structured 不会展示给人看。",
  "所以请把本节点要求的完整结论与具体数字直接写进 summary：股票代码与名称、现价与涨跌幅、止盈位/止损位、从100池里点名的标的及建议买入价、相关大盘/题材数据。",
  "按要点紧凑表达，不要只给一句泛泛而谈的摘要，也不要把要点藏进 structured；最重要的操作结论放在最前面。",
].join("\n");

const OPERATION_REPORT_FRAMEWORK = [
  "【操作汇报格式】必须逐项回答，不能只写泛泛复盘：",
  "1. 本节点操作判断：明确写建仓、加仓、减仓、清仓、持有、观望或不操作；如果判断应买卖，只能写为模拟盘提案，不能声称已经成交。",
  "2. 操作分析：说明为什么这样判断，逐条引用已提供的账户、持仓、行情、技术指标、指数、100池或新闻信息。",
  "3. 现有盘分析：说明当前现金、仓位、持仓风险、可卖数量、数据缺口和风控约束。",
  "4. 期望分析：说明本节点希望达到的效果，例如控制回撤、等待确认、提高仓位或降低风险。",
  "5. 预测与风险：给出下一阶段走势假设、触发条件、失效条件和需要继续观察的指标。",
  "6. 操作复盘：对本节点是否产生买卖提案做一句结论；最终是否成交由后端 paper-only 规则在本节点之后处理。",
].join("\n");

export interface AlarmNodeAnalysisDependencies {
  brainProvider: BrainProvider;
}

export interface AlarmNodeAnalysisResult {
  alarmType: CerebellumAlarmType;
  title: string;
  report: string;
  notification: NotificationEvent;
}

/**
 * Runs one alarm node's SOP through the brain over real data, and returns both the
 * report text and a pushable notification.
 *
 * This is the muscle behind the alarm skeleton: the deterministic SOP template
 * (objective / allowed / forbidden) is fed to the brain together with the
 * provided market context, so the node produces an actual analysis instead of an
 * empty task object. It is read-only — no orders, no account writes, no rule changes.
 */
export async function runAlarmNodeAnalysis(
  input: RunAlarmNodeInput,
  deps: AlarmNodeAnalysisDependencies,
): Promise<AlarmNodeAnalysisResult> {
  const sop = buildCerebellumAlarmSopByType(input.alarmType);
  const title = resolveSopByAlarmType(input.alarmType)?.title ?? input.alarmType;
  const occurredAt = input.now ?? new Date().toISOString();

  const swordShield = SWORD_SHIELD_NODES.has(input.alarmType);
  const nodeDisplayContract = buildNodeDisplayContract(input.alarmType);
  const holdings = input.positions ?? [];
  const holdingImpact =
    HOLDING_IMPACT_NODES.has(input.alarmType) && holdings.length > 0
      ? [
          "【逐条持仓影响评估】请结合隔夜外盘/政策/消息，对以下每只持仓各给一句【利好/利空/中性】结论并附理由，逐只回答、不得遗漏：",
          holdings.map((position) => `${position.name}(${position.symbol})`).join("、"),
        ].join("\n")
      : undefined;
  const question = [
    ...(input.priorKnowledge && input.priorKnowledge.trim()
      ? [`【过往血泪教训，开盘前反哺，供决策参考】\n${input.priorKnowledge.trim()}`, ""]
      : []),
    `请执行【${title}】这个固定流程（SOP）。`,
    renderCerebellumAlarmSop(sop),
    `目标：${sop.objective}`,
    "安全边界：",
    ...sop.forbiddenActions.map((action) => `- ${action}`),
    "基于提供的账户、行情、技术指标、指数、100支高关注池和（若有）联网检索，用简体中文产出该 SOP 要求的结论。",
    ...(input.marketPhase && input.marketPhase.trim()
      ? [`【当前行情阶段】${input.marketPhase.trim()}（据此理解现价语义：集合竞价价≠开盘价≠盘中价≠收盘价）。`]
      : []),
    ...(input.dataCaveat && input.dataCaveat.trim()
      ? [`【数据来源声明·必须如实告知】${input.dataCaveat.trim()}。请在结论里明确这一点，不要把它当作该日真实历史数据。`]
      : []),
    ...(input.poolOverview && input.poolOverview.trim()
      ? [
          `【观察池分类概览（确定性筛选，按类别）】\n${input.poolOverview.trim()}`,
          "点评时优先引用上面的分类与点名标的（涨停/昨日涨停/涨幅榜/持仓等），不要泛泛说“市场情绪高涨”；引用个股必须使用概览中给出的代码，严禁自行编造代码。",
        ]
      : []),
    ...(input.intradayTimeline && input.intradayTimeline.trim()
      ? [input.intradayTimeline.trim()]
      : []),
    ...(input.holdingsMoneyFlow && input.holdingsMoneyFlow.trim()
      ? [
          input.holdingsMoneyFlow.trim(),
          "盾(防守)分析持仓时引用上面的主力净流入：净流出说明主力在出货、需警惕；净流入说明资金仍在护盘。",
        ]
      : []),
    ...(input.dragonTiger && input.dragonTiger.trim()
      ? [
          input.dragonTiger.trim(),
          "复盘资金面时引用龙虎榜的主力净买卖与点名标的，区分游资抢筹与机构出货。",
        ]
      : []),
    ...(input.todayFills && input.todayFills.trim() ? [input.todayFills.trim()] : []),
    ...(holdingImpact ? [holdingImpact] : []),
    ...(nodeDisplayContract ? [nodeDisplayContract] : []),
    ...(swordShield ? [SWORD_SHIELD_FRAMEWORK] : ["控制在 6 句以内。"]),
    OPERATION_REPORT_FRAMEWORK,
    PUSH_DELIVERY_CONTRACT,
    FEISHU_PERSONA_CONTRACT,
    "直接给出明确结论与操作建议（模拟盘账户）。",
  ].join("\n");

  const ask = await runAskOnce(
    {
      question,
      account: input.account,
      positions: input.positions ?? [],
      prices: input.prices,
      technicals: input.technicals,
      indices: input.indices,
      watchlist: input.watchlist,
      themeHeat: input.themeHeat,
      dataHealth: input.dataHealth,
      webSearch: input.webSearch,
      now: input.now,
      metadata: { source: "alarm-node", alarmType: input.alarmType },
    },
    { brainProvider: deps.brainProvider },
  );

  const notification = notificationEventSchema.parse({
    eventId: `alarm-${input.alarmType}-${Date.parse(occurredAt)}`.slice(0, 128),
    occurredAt,
    severity: "info",
    source: { type: "cerebellum", id: "alarm-matrix" },
    target: { type: "system" },
    summary: clipText(`【${title}】\n${ask.answer}`, NOTIFICATION_SUMMARY_MAX_LENGTH),
    recommendedAction: "如需据此在模拟盘操作，直接回复即可。",
    channels: ["console", "file", "wechat"],
    metadata: {
      alarmType: input.alarmType,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });

  return { alarmType: input.alarmType, title, report: ask.answer, notification };
}

function clipText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
