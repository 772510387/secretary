/**
 * READ-ONLY preview of one alarm node's pushed content.
 *
 * Runs the EXACT real data path (buildBridgeContext: live prices, indices,
 * technicals, web search) + the real brain, then renders the notification the
 * way Feishu would — but never pushes, never trades, never writes state.
 *
 * Usage: tsx scripts/dev/preview-alarm-node.ts [alarmType]
 *   default alarmType = call_auction_watch (09:15 集合竞价观察)
 */
import { loadConfig } from "../../src/config/index.js";
import { runAlarmNodeAnalysis } from "../../src/app/index.js";
import { beijingDateTimeLabel } from "../../src/domain/shared/index.js";
import {
  FIXED_CEREBELLUM_ALARM_RULES,
  type CerebellumAlarmType,
} from "../../src/domain/cerebellum/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import { buildBridgeContext, recordIntradayCheckpoint, refreshWatchlist100 } from "./build-context.js";

const NEWS_HEAVY = new Set<CerebellumAlarmType>([
  "overnight_digest",
  "pre_market_plan",
  "call_auction_watch",
  "closing_review",
  "post_close_review",
]);

function isAlarmType(value: string): value is CerebellumAlarmType {
  return FIXED_CEREBELLUM_ALARM_RULES.some((alarm) => alarm.alarmType === value);
}

async function main(args: string[]): Promise<void> {
  const requested = args[0] ?? "call_auction_watch";
  if (!isAlarmType(requested)) {
    throw new Error(`未知节点类型：${requested}`);
  }
  const alarmType = requested;

  const config = loadConfig();
  const memoryDir = config.storage.memoryDir;
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const now = new Date().toISOString();

  console.log(`\n==== 预览节点：${alarmType} （brain=${config.brain.provider}）不推送/不交易 ====\n`);

  // Mirror the real node: 换血 first (writes the categorized 100池 + limit-board snapshot),
  // then build context (which reads the persisted 分类概览). No push, no funnel, no paper trade.
  const refresh = await refreshWatchlist100({ config, memoryDir, now });
  console.log(
    `[100池换血] ${refresh.watchlist100.length} 支${refresh.degraded ? "（降级，沿用上次的池）" : ""}${
      refresh.themeHeat && !refresh.themeHeat.degraded ? `；涨停 ${refresh.themeHeat.limitUpCount ?? "?"} 家` : ""
    }`,
  );
  if (refresh.poolOverview) {
    console.log(`\n[观察池分类概览]\n${refresh.poolOverview}\n`);
  }

  const context = await buildBridgeContext({
    config,
    memoryDir,
    question: alarmType,
    alarmType,
    forceWebSearch: NEWS_HEAVY.has(alarmType),
    includeWatchlist: true,
  });

  if (!context.account) {
    console.error("跳过：尚无模拟盘账户。");
    return;
  }

  console.log(
    `[喂给大脑的真实数据] 持仓 ${context.positions?.length ?? 0} 只 | 100池 ${context.watchlist?.length ?? 0} 支 | 报价 ${
      Object.keys(context.prices ?? {}).length
    } 个 | 指数 ${context.indices?.length ?? 0} | 联网检索 ${context.webSearch ? "有" : "无"} | 数据健康 ${
      context.dataHealth?.degraded ? "部分降级" : "完整"
    }\n`,
  );

  const intradayTimeline = recordIntradayCheckpoint({
    memoryDir,
    now,
    alarmType,
    indices: context.indices,
    positions: context.positions,
    prices: context.prices,
    themeHeat: refresh.themeHeat,
  });
  if (intradayTimeline) {
    console.log(`[日内检查点时间线]\n${intradayTimeline}\n`);
  }

  const result = await runAlarmNodeAnalysis(
    {
      alarmType,
      account: context.account,
      positions: context.positions,
      prices: context.prices,
      technicals: context.technicals,
      indices: context.indices,
      watchlist: context.watchlist,
      poolOverview: context.poolOverview,
      intradayTimeline,
      holdingsMoneyFlow: context.holdingsMoneyFlow,
      dataHealth: context.dataHealth,
      webSearch: context.webSearch,
      now,
    },
    { brainProvider },
  );

  if (context.holdingsMoneyFlow) {
    console.log(`\n[持仓资金面(Sina)]\n${context.holdingsMoneyFlow}\n`);
  }

  const event = result.notification;
  console.log("---- 飞书将推送的内容（与线上一致的渲染） ----\n");
  console.log("【INFO】Secretary 盘面提醒");
  console.log(`摘要：${event.summary}`);
  console.log(`建议：${event.recommendedAction}`);
  console.log(`来源：cerebellum:alarm-matrix`);
  console.log(`时间：${beijingDateTimeLabel(event.occurredAt)}`);
  console.log(`\n（summary 字符数：${event.summary.length}）\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
