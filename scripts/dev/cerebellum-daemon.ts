import { pathToFileURL } from "node:url";
import { ConfigLoadError, loadConfig, type AppConfig } from "../../src/config/index.js";
import {
  archiveDailySnapshot,
  assertPaperOnly,
  buildFunnelExecutionConstraints,
  createResearchRunner,
  distillDailyKnowledge,
  executePendingOrder,
  loadKnowledgeForWake,
  maintainDailyFunnel,
  persistPeriodReview,
  pruneOldArtifacts,
  readDailyFillsLedger,
  runAlarmNodeAnalysis,
  runDataWarmupSelfCheck,
  runResearchOnce,
  settleDailyPositions,
  type ExecutePendingOrderResult,
  type RunAlarmNodeInput,
  type ResearchRunner,
  type WeChatBridgeContext,
} from "../../src/app/index.js";
import type { StockSymbolInfo, ThemeHeatSummary } from "../../src/domain/market/index.js";
import {
  FIXED_CEREBELLUM_ALARM_RULES,
  buildCerebellumWakeEvent,
  dispatchCerebellumWake,
  isCerebellumAlarmDueAtBeijingTime,
  toCerebellumBeijingTime,
  type CerebellumAlarmType,
} from "../../src/domain/cerebellum/index.js";
import {
  AlarmJobRegistry,
  SimulatedClock,
  toBeijingDateTime,
} from "../../src/infrastructure/scheduler/index.js";
import { DailyBudget } from "../../src/runtime/index.js";
import {
  PlanMemoryStore,
  ProposalMemoryStore,
  ResearchMemoryStore,
} from "../../src/infrastructure/storage/index.js";
import { toBeijingDate, type JsonValue } from "../../src/domain/shared/index.js";
import {
  formatNotificationForConsole,
  notificationEventSchema,
  shouldPushToExternalChannels,
  type NotificationEvent,
} from "../../src/domain/notification/index.js";
import type { ResearchReport } from "../../src/domain/research/index.js";
import type { Position } from "../../src/domain/portfolio/index.js";
import type { PlanWatchlistEntry } from "../../src/domain/plan/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import type { BrainProvider } from "../../src/domain/brain/index.js";
import type { ExternalNotificationNotifier } from "../../src/infrastructure/notification/index.js";
import {
  buildAsOfBridgeContext,
  buildBridgeContext,
  prefetchAsOfIndexSource,
  prefetchAsOfHistory,
  readBridgeAccountAndPositions,
  readWatchlist100,
  refreshWatchlist100,
  writePotentialStocksPool,
} from "./build-context.js";
import { buildDaemonNotifiers } from "./push-notifiers.js";

const NEWS_HEAVY: ReadonlySet<CerebellumAlarmType> = new Set([
  "overnight_digest",
  "pre_market_plan",
  "call_auction_watch", // 09:15 强制搜一字板/竞价情绪(PRE-06)
  "closing_review",
  "post_close_review",
]);

/** Heavy nodes routed to the multi-agent deep-research engine when it's configured. */
const DEEP_RESEARCH_NODES: ReadonlySet<CerebellumAlarmType> = new Set(["deep_review"]);

/**
 * Nodes that 换血 the 100 高关注池 (full-market deterministic screen) before waking the brain.
 * Per Boss: EVERY fixed trading-day alarm point is itself a full-market 探查 + pool refresh —
 * not just 08:30/09:15. (Period/reflection-only nodes are excluded as they don't trade a pool,
 * but they still get the refresh-on-empty fallback below.) An empty pool at ANY node also
 * triggers a refresh — "没有就去查".
 */
const REFRESH_POOL_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "data_warmup", // 08:00 体检 — 顺带探查建池
  "overnight_digest", // 08:15 隔夜消息 — 探查建池后再逐持仓评估
  "pre_market_plan", // 08:30 晨报选股
  "call_auction_watch", // 09:15 集合竞价补池
  "pre_open_confirmation", // 09:25 开盘确认
  "morning_review", // 10:00 早盘
  "midday_review", // 11:30 午盘
  "afternoon_risk_scan", // 14:00 跳水排查
  "late_session_plan", // 14:30 尾盘
  "closing_snapshot", // 15:00 收盘
  "closing_review", // 15:30 盘后
  "post_close_review", // 盘后复盘
]);

/** Trading nodes where the funnel maintains 待买卖 + (paper) auto-executes. */
const FUNNEL_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "pre_market_plan",
  "call_auction_watch",
  "morning_review",
  "midday_review",
  "afternoon_risk_scan",
  "late_session_plan",
  "closing_review",
]);

/** Morning nodes that 反哺: read past lessons from long-term memory into the wake prompt. */
const MORNING_REBACK_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "overnight_digest", // 08:15
  "pre_market_plan", // 08:30
]);

/** Evening node that distills the day into long-term memory + review-required rule proposals. */
const DISTILL_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "next_day_watchlist", // 21:00 内省/沉淀
]);

/** Evening review nodes that get the day's actual 成交账单 injected (MEM-03). */
const FILLS_LEDGER_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "closing_review", // 15:00 收盘结算
  "post_close_review", // 15:30 盘后复盘
  "daily_reflection", // 自省
  "next_day_watchlist", // 21:00 沉淀
]);

/** Period reviews are persisted as markdown review artifacts after push. */
const PERIOD_REVIEW_NODES: ReadonlySet<CerebellumAlarmType> = new Set([
  "weekly_review",
  "monthly_review",
  "yearly_review",
]);

/** Cap deep_review fan-out so an evening batch can't run N×(minutes+tokens). */
const MAX_DEEP_REVIEW_HOLDINGS = 5;

/** Faithful replay fetches all holdings plus the ranked top of the 100-pool. */
const REPLAY_WATCHLIST_SYMBOL_LIMIT = 20;

export type AlarmPush = (notification: NotificationEvent) => Promise<void>;

export interface CerebellumSchedulerDeps {
  config: AppConfig;
  memoryDir: string;
  brainProvider: BrainProvider;
  researchRunner?: ResearchRunner;
  /** Per-day spend cap shared across alarm + research (and the sentinel). */
  budget: DailyBudget;
  push: AlarmPush;
  /**
   * 模拟盘自动成交常开 (default true): at funnel nodes the PAPER simulation auto-fills the
   * proposals. Hard-gated to paper-only inside (executePendingOrder + assertPaperOnly refuse
   * any live/non-paper config) — NEVER real money, NEVER live.
   */
  autoPaper?: boolean;
}

export interface FunnelProposalSummary {
  proposalId: string;
  side: "BUY" | "SELL";
  symbol: string;
  name?: string;
  quantity?: number;
  limitPrice?: number;
  rationale: string;
}

export interface FunnelExecutionSummary {
  side: "BUY" | "SELL";
  symbol: string;
  name?: string;
  status: ExecutePendingOrderResult["status"] | "error";
  quantity?: number;
  limitPrice?: number;
  reason?: string;
  idempotent?: boolean;
}

export interface FunnelNodeRunResult {
  alarmType: CerebellumAlarmType;
  planId?: string;
  shortlistCount: number;
  proposals: FunnelProposalSummary[];
  executions: FunnelExecutionSummary[];
  autoPaper: boolean;
  degraded: boolean;
  skippedReason?: string;
}

export interface ReplayNodeRunResult {
  alarmType: CerebellumAlarmType;
  beijingTime: string;
  report: string;
  funnel?: FunnelNodeRunResult;
  error?: string;
}

export interface ReplayDayRunResult {
  date: string;
  nodeCount: number;
  nodes: ReplayNodeRunResult[];
}

/** Builds the per-node runner: heavy nodes -> deep research, the rest -> SOP+brain. */
export function createAlarmRunNode(
  deps: CerebellumSchedulerDeps,
): (alarmType: CerebellumAlarmType, now: string) => Promise<void> {
  return async (alarmType, now) => {
    try {
      // HAND-02: T+1 cross-day settlement before anything reads positions this node, so the
      // funnel/context see correct sellable shares (prior-day buys are no longer stuck).
      const settled = settleDailyPositions({
        config: deps.config,
        memoryDir: deps.memoryDir,
        tradingDate: toBeijingDate(now).date,
      });
      if (settled.changed > 0) {
        console.log(`(${alarmType} T+1 结算：${settled.changed} 只持仓的昨日买入已转为可卖)`);
      }

      if (deps.researchRunner && DEEP_RESEARCH_NODES.has(alarmType)) {
        await runDeepResearchNode(deps, alarmType, now);
        return;
      }

      // 换血 (eye): every trading-day node is a full-market 探查 that rebuilds the 100 高关注池
      // deterministically before the brain wakes; ANY node also refreshes when the pool is empty
      // ("没有就去查"). Also captures the market-wide 新题材热度 for the brain/funnel.
      let themeHeat: ThemeHeatSummary | undefined;
      const poolEmpty = readWatchlist100(deps.memoryDir).length === 0;
      if (REFRESH_POOL_NODES.has(alarmType) || poolEmpty) {
        const refresh = await refreshWatchlist100({ config: deps.config, memoryDir: deps.memoryDir });
        themeHeat = refresh.themeHeat;
        const note =
          refresh.watchlist100.length === 0
            ? "（探查到 0 支：行情数据源未就绪/网络不可用，已降级；请检查联网/代理）"
            : refresh.degraded
              ? "（降级，沿用上次的池）"
              : "";
        console.log(
          `(${alarmType} 全市场探查·100池换血：${refresh.watchlist100.length} 支${note}${
            themeHeat && !themeHeat.degraded ? `；涨停 ${themeHeat.limitUpCount ?? "?"} 家，热度 ${themeHeat.heatScore}` : ""
          })`,
        );
      }

      const context = await buildBridgeContext({
        config: deps.config,
        memoryDir: deps.memoryDir,
        question: alarmType,
        alarmType,
        forceWebSearch: NEWS_HEAVY.has(alarmType),
        includeWatchlist: true,
      });

      // PRE-01: deterministic 08:00 体检 — confirm the ledger is present and the pool is
      // populated before the brain wakes (local self-check, logged; not pushed as noise).
      if (alarmType === "data_warmup") {
        const check = runDataWarmupSelfCheck({
          account: context.account ?? null,
          positions: context.positions ?? [],
          watchlistCount: context.watchlist?.length ?? 0,
        });
        console.log(
          `(data_warmup 体检：账户${check.accountPresent ? "在" : "缺失"}、持仓 ${check.positionsCount} 只、100池 ${check.watchlistCount} 支、可用现金 ${check.cashAvailable ?? "?"}${
            check.ok ? "；自检通过" : `；告警：${check.notes.join("；")}`
          })`,
        );
      }

      if (!context.account) {
        console.error(`(${alarmType} 跳过：尚无模拟盘账户，请先建账户。)`);
        return;
      }

      if (!deps.budget.tryConsume("brain")) {
        console.error(`(${alarmType} 跳过：今日大脑调用预算已用尽)`);
        return;
      }

      // A1: the cerebellum→brain "neural impulse". The small-brain has prepared the data
      // (换血 + context + 反哺); this standardised wake envelope is the openclaw systemEvent
      // analogue that hands off to the big-brain. Code still owns WHEN to fire (the matrix).
      await dispatchCerebellumWake(
        buildCerebellumWakeEvent({
          source: "alarm_matrix",
          kind: "scheduled_node",
          text: `${alarmType} 数据已备齐（${context.dataHealth?.degraded ? "部分降级" : "完整"}），请大脑开始分析并向 Boss 汇报。`,
          occurredAt: now,
          alarmType,
          dataReady: true,
        }),
        {
          onWake: (event) =>
            console.log(`(🧠 唤醒大脑 ${event.source}/${event.alarmType ?? event.kind}，wakeId=${event.wakeId})`),
        },
      );

      // 反哺: morning nodes prepend past lessons (read-only, best-effort) to the wake prompt.
      // MEM-07: bias retrieval toward today's holdings + top theme via the registry search.
      const priorKnowledge = MORNING_REBACK_NODES.has(alarmType)
        ? loadKnowledgeForWake({
            memoryDir: deps.memoryDir,
            asOfDate: toBeijingDate(now).date,
            relevanceQuery: buildRebackRelevanceQuery(context, themeHeat),
          }).asText()
        : undefined;

      // MEM-03: evening review nodes get the day's real 成交账单 (no guessing what was traded).
      const todayFills = FILLS_LEDGER_NODES.has(alarmType)
        ? readDailyFillsLedger({
            config: deps.config,
            memoryDir: deps.memoryDir,
            tradingDate: toBeijingDate(now).date,
          })?.rendered
        : undefined;

      const input: RunAlarmNodeInput = {
        alarmType,
        account: context.account,
        positions: context.positions,
        prices: context.prices,
        technicals: context.technicals,
        indices: context.indices,
        watchlist: context.watchlist,
        themeHeat,
        dataHealth: context.dataHealth,
        webSearch: context.webSearch,
        priorKnowledge,
        todayFills,
        now,
      };
      const result = await runAlarmNodeAnalysis(input, { brainProvider: deps.brainProvider });
      await deps.push(result.notification);

      if (PERIOD_REVIEW_NODES.has(alarmType)) {
        try {
          const persisted = persistPeriodReview({
            memoryDir: deps.memoryDir,
            reviewType: alarmType as "weekly_review" | "monthly_review" | "yearly_review",
            title: result.title,
            report: result.report,
            generatedAt: now,
            metadata: {
              alarmType,
              brokerConnected: false,
              directExecutionAllowed: false,
              liveTrading: false,
            },
          });
          console.log(
            `(${alarmType} 复盘落盘：${persisted.path}${persisted.appended ? "（追加）" : ""})`,
          );
        } catch (error) {
          console.error(`(${alarmType} 复盘落盘失败，跳过：${error instanceof Error ? error.message : String(error)})`);
        }
      }

      // 待买卖 maintenance + paper auto-execute at trading nodes (the hands).
      if (FUNNEL_NODES.has(alarmType)) {
        await runFunnelNode(deps, alarmType, context, now, themeHeat);
      }

      // 盘后落库归档 (15:30): deterministic daily snapshot + summary (no model).
      if (alarmType === "post_close_review") {
        try {
          const archived = archiveDailySnapshot({
            memoryDir: deps.memoryDir,
            account: context.account,
            positions: context.positions ?? [],
            prices: context.prices,
            tradingDate: now.slice(0, 10),
            now,
          });
          console.log(
            `(${alarmType} 落库：总资产 ${archived.summary.totalAssets}，持仓 ${archived.summary.positionCount} 只，浮盈亏 ${archived.summary.totalUnrealizedPnl})`,
          );
        } catch (error) {
          console.error(`(${alarmType} 落库失败，跳过：${error instanceof Error ? error.message : String(error)})`);
        }
      }

      // 沉淀 (记忆): distill the day into long-term memory + review-required rule proposals.
      if (DISTILL_NODES.has(alarmType) && deps.budget.tryConsume("brain")) {
        try {
          const distilled = await distillDailyKnowledge(
            { memoryDir: deps.memoryDir, tradingDate: now.slice(0, 10), now },
            { brainProvider: deps.brainProvider },
          );
          console.log(
            `(${alarmType} 知识沉淀：教训 ${distilled.lessonsWritten} 条，规则提议 ${distilled.ruleProposalsCreated} 条${distilled.degraded ? "（当日无可沉淀数据）" : ""})`,
          );
        } catch (error) {
          console.error(`(${alarmType} 知识沉淀失败，跳过：${error instanceof Error ? error.message : String(error)})`);
        }
      }

      // 数据库清洗 (21:00): prune clearly-ephemeral old artifacts (plans/cache), conservative.
      if (DISTILL_NODES.has(alarmType)) {
        try {
          const pruned = pruneOldArtifacts({ memoryDir: deps.memoryDir, keepDays: 30, now });
          if (pruned.removed.length > 0) {
            console.log(`(${alarmType} 数据库清洗：归档/清理 ${pruned.removed.length} 项 30 天前的旧数据)`);
          }
        } catch (error) {
          console.error(`(${alarmType} 清洗失败，跳过：${error instanceof Error ? error.message : String(error)})`);
        }
      }
    } catch (error) {
      console.error(`(${alarmType} 本次失败，已跳过：${error instanceof Error ? error.message : String(error)})`);
    }
  };
}

/**
 * Maintains the daily funnel for ONE trading node: the model selects 待买/待卖 from the
 * refreshed 100池 + current holdings (proposals, executable:false), we persist plan + proposals
 * and push a summary. With auto-paper ON (default) and a strictly-paper config, the proposals
 * are then filled in the PAPER simulation using the prices already fetched for this node, and a
 * "已执行" report is pushed. The model NEVER executes; the hard paper gate refuses any live config.
 */
async function runFunnelNode(
  deps: CerebellumSchedulerDeps,
  alarmType: CerebellumAlarmType,
  context: WeChatBridgeContext,
  now: string,
  themeHeat?: ThemeHeatSummary,
): Promise<FunnelNodeRunResult | undefined> {
  const account = context.account;
  if (!account) {
    return skippedFunnel(alarmType, "尚无模拟盘账户");
  }
  const watchlist100 = context.watchlist ?? [];
  if (watchlist100.length === 0) {
    console.error(`(${alarmType} 选股漏斗跳过：100池为空)`);
    return skippedFunnel(alarmType, "100池为空");
  }
  if (!deps.budget.tryConsume("brain")) {
    console.error(`(${alarmType} 选股漏斗跳过：今日大脑预算已用尽)`);
    return skippedFunnel(alarmType, "今日大脑预算已用尽");
  }

  // 模拟盘自动成交常开 — but ONLY if the config is strictly paper; else propose-only.
  let autoPaper = deps.autoPaper !== false;
  if (autoPaper) {
    try {
      assertPaperOnly(deps.config, account);
    } catch (error) {
      console.error(`(${alarmType} 自动成交关闭，仅提案：${error instanceof Error ? error.message : String(error)})`);
      autoPaper = false;
    }
  }
  const executionConstraints = buildFunnelExecutionConstraints({
    account,
    positions: context.positions ?? [],
    watchlist100,
    prices: context.prices,
    config: deps.config,
    maxBuyOrders: 2,
    maxSellOrders: 2,
  });

  const { plan, proposals, degraded } = await maintainDailyFunnel(
    {
      alarmType,
      tradingDate: now.slice(0, 10),
      asOf: now,
      accountId: account.accountId,
      watchlist100,
      holdings: (context.positions ?? []).map((position) => ({
        symbol: position.symbol,
        market: position.market,
        name: position.name,
      })),
      autoPaper,
      brainContext: funnelBrainContext(context, themeHeat),
      executionConstraints,
    },
    {
      brainProvider: deps.brainProvider,
      planStore: new PlanMemoryStore({ memoryDir: deps.memoryDir }),
      proposalStore: new ProposalMemoryStore({ memoryDir: deps.memoryDir }),
      notifiers: [{ notify: (event) => void deps.push(event) }],
    },
  );
  // PRE-05: mirror the 10 潜力股 to potential_stocks.json (standalone spec artifact).
  if (plan.shortlist10.length > 0) {
    try {
      const written = writePotentialStocksPool({
        memoryDir: deps.memoryDir,
        shortlist: plan.shortlist10,
        now,
      });
      console.log(`(${alarmType} 潜力股落盘 potential_stocks.json：${written} 支)`);
    } catch (error) {
      console.error(
        `(${alarmType} 潜力股落盘失败：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const proposalSummaries = proposals
    .filter((proposal) => proposal.side === "BUY" || proposal.side === "SELL")
    .map((proposal) => ({
      proposalId: proposal.proposalId,
      side: proposal.side as "BUY" | "SELL",
      symbol: proposal.symbol,
      name: proposal.name,
      quantity: proposal.quantity,
      limitPrice: proposal.limitPrice,
      rationale: proposal.rationale,
    }));

  if (!autoPaper || proposals.length === 0) {
    return {
      alarmType,
      planId: plan.planId,
      shortlistCount: plan.shortlist10.length,
      proposals: proposalSummaries,
      executions: [],
      autoPaper,
      degraded,
    };
  }

  // Auto-fill in PAPER using the prices already fetched for pool∪positions this node.
  const executions: FunnelExecutionSummary[] = [];
  for (const proposal of proposals) {
    if (proposal.side !== "BUY" && proposal.side !== "SELL") {
      continue;
    }
    const price = proposal.limitPrice ?? context.prices?.[proposal.symbol];
    if (price === undefined || price <= 0) {
      executions.push({
        side: proposal.side,
        symbol: proposal.symbol,
        name: proposal.name,
        status: "skipped",
        reason: "无报价",
      });
      continue;
    }
    try {
      const result = executePendingOrder(
        { proposal, latestPrice: price, reviewer: "auto-paper" },
        { config: deps.config, memoryDir: deps.memoryDir },
      );
      executions.push({
        side: proposal.side,
        symbol: proposal.symbol,
        name: proposal.name,
        status: result.status,
        quantity: result.quantity,
        limitPrice: result.limitPrice,
        reason: result.reason,
        idempotent: result.idempotent,
      });
    } catch (error) {
      executions.push({
        side: proposal.side,
        symbol: proposal.symbol,
        name: proposal.name,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await deps.push(buildExecutionReport(alarmType, executions, now));
  return {
    alarmType,
    planId: plan.planId,
    shortlistCount: plan.shortlist10.length,
    proposals: proposalSummaries,
    executions,
    autoPaper,
    degraded,
  };
}

/** MEM-07: short relevance query for the morning reback — today's holdings + top theme names. */
function buildRebackRelevanceQuery(
  context: WeChatBridgeContext,
  themeHeat?: ThemeHeatSummary,
): string | undefined {
  const names = new Set<string>();
  for (const position of context.positions ?? []) {
    if (position.name) {
      names.add(position.name);
    }
  }
  for (const gainer of themeHeat?.topGainers?.slice(0, 2) ?? []) {
    if (gainer.name) {
      names.add(gainer.name);
    }
  }
  const query = [...names].join(" ").trim();
  return query.length > 0 ? query : undefined;
}

function skippedFunnel(alarmType: CerebellumAlarmType, reason: string): FunnelNodeRunResult {
  return {
    alarmType,
    shortlistCount: 0,
    proposals: [],
    executions: [],
    autoPaper: false,
    degraded: true,
    skippedReason: reason,
  };
}

/** Lean de-identified context (indices + held technicals + 题材热度) for the funnel's model selection. */
function funnelBrainContext(
  context: WeChatBridgeContext,
  themeHeat?: ThemeHeatSummary,
): Record<string, JsonValue> {
  return {
    indices: (context.indices ?? []).map((index) => ({
      name: index.name,
      changePct: index.changePct,
    })),
    heldTechnicals: (context.technicals ?? []).map((technical) => ({
      symbol: technical.symbol,
      trend: technical.trend,
      rangePosition60: technical.rangePosition60,
    })),
    ...(themeHeat && !themeHeat.degraded
      ? {
          themeHeat: {
            limitUpCount: themeHeat.limitUpCount,
            advancers: themeHeat.advancers,
            decliners: themeHeat.decliners,
            heatScore: themeHeat.heatScore,
          },
        }
      : {}),
    ...(context.dataHealth ? { degraded: context.dataHealth.degraded } : {}),
  };
}

/** "做完汇报" — a post-execution report of what the paper simulation just did. */
function buildExecutionReport(
  alarmType: CerebellumAlarmType,
  executions: FunnelExecutionSummary[],
  now: string,
): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: `funnel-exec-${alarmType}-${Date.parse(now)}`.slice(0, 128),
    occurredAt: now,
    severity: "info",
    source: { type: "scheduler", id: "daily-funnel" },
    target: { type: "system" },
    summary: `【模拟盘后端处理·${alarmType}】\n${executions.map(formatExecutionSummary).join("\n")}`.slice(0, 1000),
    recommendedAction: "仅 paper 模拟盘：模型只选择方向和标的，具体股数/限价由后端预计算，后端按现金、仓位、T+1、100股买入、主板和风控规则执行并写库；永不触实盘。",
    channels: ["feishu"],
    metadata: { funnel: true, autoPaper: true, liveTrading: false, brokerConnected: false },
  });
}

function formatExecutionSummary(execution: FunnelExecutionSummary): string {
  const name = execution.name ? ` ${execution.name}` : "";
  const fill =
    execution.quantity !== undefined && execution.limitPrice !== undefined
      ? ` ${execution.quantity}股@${execution.limitPrice}`
      : "";
  const reason = execution.reason ? `（${execution.reason}）` : "";
  const idempotent = execution.idempotent ? "（重复执行已幂等复用原成交）" : "";
  return `${execution.side} ${execution.symbol}${name}：${execution.status}${fill}${reason}${idempotent}`;
}

async function runDeepResearchNode(
  deps: CerebellumSchedulerDeps,
  alarmType: CerebellumAlarmType,
  now: string,
): Promise<void> {
  const context = await buildBridgeContext({ config: deps.config, memoryDir: deps.memoryDir, question: alarmType });
  const positions = context.positions ?? [];

  if (positions.length === 0) {
    return;
  }

  // Cap the batch to the largest holdings (by cost basis) — bounded cost.
  const ranked = [...positions]
    .sort((a, b) => b.costPrice * b.quantity - a.costPrice * a.quantity)
    .slice(0, MAX_DEEP_REVIEW_HOLDINGS);
  const writer = new ResearchMemoryStore({ memoryDir: deps.memoryDir });

  // One deep-research run per holding (slow; fires once in the evening). Each is
  // isolated (a failure skips that holding, not the rest) and budget-gated.
  for (const position of ranked) {
    if (!deps.budget.tryConsume("research")) {
      console.error("(深度复盘：今日研究预算已用尽，停止)");
      break;
    }

    try {
      const result = await runResearchOnce({
        symbol: position.symbol,
        market: position.market,
        name: position.name,
        tradingDate: now.slice(0, 10),
        objective: "盘后深度复盘：今日表现、风险与明日策略",
        runner: deps.researchRunner,
        now,
        writer,
        writeToMemory: true, // persist the expensive report to memory/research
      });
      await deps.push(deepResearchNotification(result.report, position, now));
    } catch (error) {
      console.error(
        `(深度复盘 ${position.symbol} 失败，跳过该只：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}

function deepResearchNotification(report: ResearchReport, position: Position, now: string): NotificationEvent {
  return notificationEventSchema.parse({
    eventId: `alarm-deep-review-${position.symbol}-${Date.parse(now)}`.slice(0, 128),
    occurredAt: now,
    severity: "info",
    source: { type: "cerebellum", id: "deep-review" },
    target: { type: "symbol", symbol: position.symbol, market: position.market, name: position.name },
    summary: `【深度复盘 · ${position.name} ${position.symbol}】结论：${conclusionZh(report.conclusion)}\n${report.summary}`.slice(0, 1000),
    recommendedAction: "多智能体研判，仅供参考，需人工复核；不自动下单、不接真实券商。",
    channels: ["console", "file", "wechat"],
    metadata: {
      alarmType: "deep_review",
      symbol: position.symbol,
      brainAnalyzed: true,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function conclusionZh(conclusion: ResearchReport["conclusion"]): string {
  if (conclusion === "bullish") {
    return "偏多";
  }
  if (conclusion === "bearish") {
    return "偏空";
  }
  if (conclusion === "mixed") {
    return "分歧";
  }
  return "中性";
}

/** Registers the alarm matrix and ticks it every 30s; returns a stop handle. */
export function startCerebellumAlarmScheduler(deps: CerebellumSchedulerDeps): { stop(): void } {
  const runNode = createAlarmRunNode(deps);
  const registry = new AlarmJobRegistry();

  for (const alarm of FIXED_CEREBELLUM_ALARM_RULES) {
    registry.register({
      jobId: alarm.jobId,
      beijingTime: alarm.beijingTime,
      weekdaysOnly: alarm.weekdaysOnly,
      shouldRun: (beijingTime) => isCerebellumAlarmDueAtBeijingTime(alarm, beijingTime),
      task: (taskContext) => runNode(alarm.alarmType, taskContext.scheduledAt),
    });
  }

  // Tick every 30s so a minute is never skipped; runDue dedups each slot per day.
  const timer = setInterval(() => {
    void registry.runDue().catch((error: unknown) => {
      console.error(`(闹钟调度本轮出错：${error instanceof Error ? error.message : String(error)})`);
    });
  }, 30_000);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}

export function buildAlarmPush(notifiers: ExternalNotificationNotifier[]): AlarmPush {
  return async (notification) => {
    console.log(formatNotificationForConsole(notification));
    // Operator push gate: only executed operations, hard red-lines, and scheduled
    // reports reach external channels; intraday radar noise stays in the local log.
    if (!shouldPushToExternalChannels(notification)) {
      return;
    }
    for (const notifier of notifiers) {
      try {
        const result = await notifier.notify(notification);
        if (result.status === "failed") {
          console.error(`[推送失败] ${notifier.channel}：${result.error ?? "未知错误"}`);
        }
      } catch (error) {
        // A notification failure must never crash the daemon — but surface it so a
        // misconfigured channel (e.g. missing Feishu send permission) is visible.
        console.error(
          `[推送异常] ${notifier.channel}：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };
}

export function buildDailyBudget(config: AppConfig): DailyBudget {
  return new DailyBudget({
    brain: config.budget.brainDailyLimit,
    research: config.budget.researchDailyLimit,
    search: config.budget.searchDailyLimit,
  });
}

export function buildCerebellumDeps(
  config: AppConfig,
  budget?: DailyBudget,
  notifiers?: ExternalNotificationNotifier[],
): CerebellumSchedulerDeps {
  return {
    config,
    memoryDir: config.storage.memoryDir,
    brainProvider:
      config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain),
    researchRunner:
      config.research.provider === "trading_agents_cn" ? createResearchRunner(config) : undefined,
    budget: budget ?? buildDailyBudget(config),
    // The caller (daemon main) passes the configured external notifiers (Feishu).
    push: buildAlarmPush(notifiers ?? []),
    // 模拟盘自动成交常开 (paper-gated inside; live never auto).
    autoPaper: true,
  };
}

export async function main(args: string[]): Promise<void> {
  const cli = parseArgs(args);

  if (cli.help) {
    printHelp();
    return;
  }

  if (cli.list) {
    for (const alarm of FIXED_CEREBELLUM_ALARM_RULES) {
      const heavy = DEEP_RESEARCH_NODES.has(alarm.alarmType) ? "  [深度研究]" : "";
      console.log(`${alarm.beijingTime}  ${alarm.alarmType}  (${alarm.frequency})${heavy}`);
    }
    return;
  }

  const config = loadConfig();
  const notifiers = await buildDaemonNotifiers(config);
  const deps = buildCerebellumDeps(config, undefined, notifiers);
  const isReal = config.brain.provider !== "mock";

  if (cli.fire) {
    if (!isReal) {
      console.log("注意：BRAIN_PROVIDER=mock，产出为占位文本。设真实 provider 才有真分析。");
    }
    console.log(`手动触发闹钟节点：${cli.fire}`);
    await createAlarmRunNode(deps)(cli.fire, new Date().toISOString());
    return;
  }

  if (cli.fireAll) {
    if (!isReal) {
      console.log("注意：BRAIN_PROVIDER=mock，产出为占位文本。设真实 provider 才有真分析。");
    }
    await fireTodayDueNodes(deps);
    return;
  }

  if (cli.replayDay) {
    if (!isReal) {
      console.log("注意：BRAIN_PROVIDER=mock，产出为占位文本。设真实 provider 才有真分析。");
    }
    await runReplayDay(deps, cli.replayDay);
    return;
  }

  console.log(
    `🧠 Cerebellum 闹钟守护已启动（${FIXED_CEREBELLUM_ALARM_RULES.length} 个节点，brain=${config.brain.provider}${
      deps.researchRunner ? " + 深度研究(deep_review)" : ""
    }${config.feishu.notify ? " + 飞书主动推送" : ""}）。Ctrl+C 退出。`,
  );
  if (!isReal) {
    console.log("注意：BRAIN_PROVIDER=mock，到点只产出占位文本。设真实 provider（如 dashscope）才有真分析。");
  }
  console.log(`当前北京时间：${beijingNow()}`);

  const scheduler = startCerebellumAlarmScheduler(deps);
  await waitForShutdownSignal();
  scheduler.stop();
  console.log("Cerebellum 闹钟守护已停止。");
}

interface CerebellumDaemonCliOptions {
  help: boolean;
  list: boolean;
  fire?: CerebellumAlarmType;
  fireAll: boolean;
  replayDay?: string;
}

function parseArgs(args: string[]): CerebellumDaemonCliOptions {
  const options: CerebellumDaemonCliOptions = { help: false, list: false, fireAll: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--fire-all") {
      options.fireAll = true;
    } else if (arg === "--replay-day") {
      const value = args[index + 1];
      index += 1;
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new CerebellumDaemonCliError("--replay-day 需要一个 YYYY-MM-DD 日期，如 2026-06-22。");
      }
      options.replayDay = value;
    } else if (arg === "--fire") {
      const value = args[index + 1];
      index += 1;
      if (!value || !isAlarmType(value)) {
        throw new CerebellumDaemonCliError(
          `--fire 需要一个有效节点类型，如 pre_market_plan。可用：${alarmTypes().join(", ")}`,
        );
      }
      options.fire = value;
    } else {
      throw new CerebellumDaemonCliError(`未知参数：${arg}`);
    }
  }

  return options;
}

/** Same-day daily bar is "settled" only from 15:30 Beijing — matches the P0 replay boundary. */
const POST_CLOSE_MINUTE = 15 * 60 + 30;

export interface ReplayDayOptions {
  /**
   * INFRA-01: when the stored 100池 is empty, rebuild it via a live deterministic 换血
   * (成交额 TOP, main-board only) so the funnel actually has candidates to act on.
   * NOTE: this uses TODAY's universe, NOT an as-of historical screen — it breaks strict
   * as-of faithfulness on purpose, and the run logs the caveat. Default false.
   */
  refreshWatchlistWhenEmpty?: boolean;
}

/**
 * FAITHFUL replay of a day (no look-ahead): for each alarm node due on `date`, build an
 * AS-OF-bounded context (prices/technicals only through that node's time — pre-close nodes
 * see the prior trading day), run the real node SOP + brain, and push (e.g. into Feishu).
 * Unlike --fire-all (which uses current live data), each node here only sees information
 * available at its own time. Limits: account/positions are the current stored state (no
 * historical snapshot); web search and intraday (sub-daily) data are omitted because there
 * is no bounded as-of source for them; deep_review is skipped (its multi-agent engine pulls live data).
 *
 * Exception: with `refreshWatchlistWhenEmpty`, an empty stored pool is rebuilt from the
 * CURRENT universe (non-as-of) so "走一遍某日" produces real funnel output instead of all-skips.
 */
export async function runReplayDay(
  deps: CerebellumSchedulerDeps,
  date: string,
  options: ReplayDayOptions = {},
): Promise<ReplayDayRunResult> {
  const initialState = readBridgeAccountAndPositions(deps.memoryDir);
  if (!initialState.account) {
    console.error("未找到模拟盘账户，请先建账户。");
    return { date, nodeCount: 0, nodes: [] };
  }

  // HAND-02: settle T+1 to the replay date so a sell the day after a buy can fill in the replay.
  const settled = settleDailyPositions({ config: deps.config, memoryDir: deps.memoryDir, tradingDate: date });
  if (settled.changed > 0) {
    console.log(`(重演 T+1 结算：${settled.changed} 只持仓的昨日买入已转为可卖)`);
  }

  const clock = new SimulatedClock();
  const dueNodes = FIXED_CEREBELLUM_ALARM_RULES.map((rule) => {
    clock.setToBeijingInstant(date, rule.beijingTime);
    const instant = clock.now();
    return { rule, instant, beijing: toCerebellumBeijingTime(instant) };
  })
    .filter((entry) => isCerebellumAlarmDueAtBeijingTime(entry.rule, entry.beijing))
    .filter((entry) => !DEEP_RESEARCH_NODES.has(entry.rule.alarmType))
    .sort((left, right) => left.rule.priority - right.rule.priority);

  if (dueNodes.length === 0) {
    console.log(`${date} 没有可忠实重演的节点（周末/节假日规则，或仅有 deep_review）。`);
    return { date, nodeCount: 0, nodes: [] };
  }

  let watchlist = readWatchlist100(deps.memoryDir);
  if (watchlist.length === 0 && options.refreshWatchlistWhenEmpty) {
    console.log("(重演前 100池为空，执行一次当日换血补池；注意：使用当日 universe，非严格 as-of)");
    try {
      const refresh = await refreshWatchlist100({ config: deps.config, memoryDir: deps.memoryDir });
      watchlist = refresh.watchlist100;
      console.log(
        `(重演补池：${watchlist.length} 支${refresh.degraded ? "（换血降级，仍为空或沿用上次）" : ""})`,
      );
    } catch (error) {
      console.error(
        `(重演补池失败：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  const symbols = replaySymbolsFrom(initialState.positions, watchlist, REPLAY_WATCHLIST_SYMBOL_LIMIT);
  const historyProvider = await prefetchAsOfHistory(symbols, deps.config, date);
  const indexSource = await prefetchAsOfIndexSource(deps.config, date);
  const nodes: ReplayNodeRunResult[] = [];

  console.log(
    `忠实重演 ${date}：${dueNodes.length} 个节点（严格 as-of、无未来函数；覆盖持仓 ${initialState.positions.length} 只 + 100池 top ${Math.min(
      watchlist.length,
      REPLAY_WATCHLIST_SYMBOL_LIMIT,
    )}；指数使用历史 K 线 as-of；联网/盘中分钟数据无 as-of 源已省略；deep_review 跳过）。`,
  );

  for (const { rule, instant, beijing } of dueNodes) {
    const currentState = readBridgeAccountAndPositions(deps.memoryDir);
    if (!currentState.account) {
      const error = "模拟盘账户在重演过程中不可用";
      console.error(`(${rule.alarmType} 重演失败，跳过：${error})`);
      nodes.push({ alarmType: rule.alarmType, beijingTime: rule.beijingTime, report: "", error });
      continue;
    }

    const sameDayBarIncluded = beijing.minuteOfDay >= POST_CLOSE_MINUTE;
    const context = await buildAsOfBridgeContext({
      account: currentState.account,
      positions: currentState.positions,
      watchlist,
      maxWatchlistSymbols: REPLAY_WATCHLIST_SYMBOL_LIMIT,
      asOfDate: date,
      sameDayBarIncluded,
      historyProvider,
      indexSource,
    });

    if (!deps.budget.tryConsume("brain")) {
      console.error(`(${rule.alarmType} 跳过：今日大脑调用预算已用尽)`);
      continue;
    }

    try {
      const todayFills = FILLS_LEDGER_NODES.has(rule.alarmType)
        ? readDailyFillsLedger({ config: deps.config, memoryDir: deps.memoryDir, tradingDate: date })?.rendered
        : undefined;
      const input: RunAlarmNodeInput = {
        alarmType: rule.alarmType,
        account: currentState.account,
        positions: currentState.positions,
        prices: context.prices,
        technicals: context.technicals,
        indices: context.indices,
        watchlist: context.watchlist,
        dataHealth: context.dataHealth,
        webSearch: context.webSearch,
        todayFills,
        now: instant.toISOString(),
      };
      const result = await runAlarmNodeAnalysis(input, { brainProvider: deps.brainProvider });
      await deps.push(result.notification);
      let funnel: FunnelNodeRunResult | undefined;
      if (FUNNEL_NODES.has(rule.alarmType)) {
        funnel = await runFunnelNode(deps, rule.alarmType, context, instant.toISOString());
      }
      if (PERIOD_REVIEW_NODES.has(rule.alarmType)) {
        const persisted = persistPeriodReview({
          memoryDir: deps.memoryDir,
          reviewType: rule.alarmType as "weekly_review" | "monthly_review" | "yearly_review",
          title: result.title,
          report: result.report,
          generatedAt: instant.toISOString(),
          metadata: {
            alarmType: rule.alarmType,
            replayDate: date,
            brokerConnected: false,
            directExecutionAllowed: false,
            liveTrading: false,
          },
        });
        console.log(`(${rule.alarmType} 重演复盘落盘：${persisted.path}${persisted.appended ? "（追加）" : ""})`);
      }
      console.log(
        `▶ ${rule.beijingTime} ${rule.alarmType} 已重演（行情截至${sameDayBarIncluded ? `当日 ${date}` : "前一交易日"}）`,
      );
      nodes.push({
        alarmType: rule.alarmType,
        beijingTime: rule.beijingTime,
        report: clipText(result.report, 500),
        funnel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `(${rule.alarmType} 重演失败，跳过：${message})`,
      );
      nodes.push({
        alarmType: rule.alarmType,
        beijingTime: rule.beijingTime,
        report: "",
        error: message,
      });
    }
  }

  console.log("✅ 忠实重演完成（已按配置推送到飞书/企业微信）。");
  return { date, nodeCount: dueNodes.length, nodes };
}

function replaySymbolsFrom(
  positions: Position[],
  watchlist: PlanWatchlistEntry[],
  watchlistLimit: number,
): StockSymbolInfo[] {
  const seen = new Set<string>();
  const symbols: StockSymbolInfo[] = [];

  for (const position of positions) {
    if (seen.has(position.symbol)) {
      continue;
    }
    seen.add(position.symbol);
    symbols.push({ symbol: position.symbol, market: position.market, name: position.name });
  }

  for (const entry of [...watchlist]
    .sort((left, right) => (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY))
    .slice(0, watchlistLimit)) {
    if (seen.has(entry.symbol)) {
      continue;
    }
    seen.add(entry.symbol);
    symbols.push({ symbol: entry.symbol, market: entry.market, name: entry.name });
  }

  return symbols;
}

/**
 * Backfill every alarm node scheduled for TODAY (Beijing), in time order, running each
 * node's analysis with current live data and pushing it (e.g. into Feishu). Nodes not due
 * today (weekend/weekly/monthly/yearly when not applicable) are skipped. Used to "replay"
 * a day's full sequence after the resident daemon was not running.
 */
export interface RunDueNodesForDateOptions {
  includeAlarmTypes?: ReadonlySet<CerebellumAlarmType>;
  skipAlarmTypes?: ReadonlySet<CerebellumAlarmType>;
}

export async function runDueNodesForDate(
  deps: CerebellumSchedulerDeps,
  date: string,
  options: RunDueNodesForDateOptions = {},
): Promise<void> {
  const clock = new SimulatedClock();

  const dueToday = FIXED_CEREBELLUM_ALARM_RULES.map((rule) => {
    clock.setToBeijingInstant(date, rule.beijingTime);
    const instant = clock.now();
    return {
      rule,
      instant,
      due: isCerebellumAlarmDueAtBeijingTime(rule, toCerebellumBeijingTime(instant)),
    };
  })
    .filter((entry) => entry.due)
    .filter((entry) => !options.includeAlarmTypes || options.includeAlarmTypes.has(entry.rule.alarmType))
    .filter((entry) => !options.skipAlarmTypes || !options.skipAlarmTypes.has(entry.rule.alarmType))
    .sort((left, right) => left.rule.priority - right.rule.priority);

  if (dueToday.length === 0) {
    console.log(`${date} 没有应触发的闹钟节点（可能是周末/节假日规则，或过滤条件排除了全部节点）。`);
    return;
  }

  console.log(
    `${date} 依次补跑 ${dueToday.length} 个节点：${dueToday
      .map((entry) => `${entry.rule.beijingTime} ${entry.rule.alarmType}`)
      .join("、")}`,
  );

  for (const { rule, instant } of dueToday) {
    const heavy = DEEP_RESEARCH_NODES.has(rule.alarmType) ? "（深度研究，较慢，单次数分钟）" : "";
    console.log(`▶ ${rule.beijingTime} ${rule.alarmType}${heavy}`);
    await createAlarmRunNode(deps)(rule.alarmType, instant.toISOString());
  }

  console.log(`✅ ${date} 节点已全部补跑（控制台见摘要，已按配置推送到飞书/企业微信）。`);
}

async function fireTodayDueNodes(deps: CerebellumSchedulerDeps): Promise<void> {
  const today = toBeijingDateTime(new Date()).date;
  await runDueNodesForDate(deps, today);
}

function alarmTypes(): CerebellumAlarmType[] {
  return [...new Set(FIXED_CEREBELLUM_ALARM_RULES.map((alarm) => alarm.alarmType))];
}

function isAlarmType(value: string): value is CerebellumAlarmType {
  return alarmTypes().includes(value as CerebellumAlarmType);
}

function clipText(text: string, max: number): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function beijingNow(): string {
  const beijing = toBeijingDateTime(new Date());
  return `${beijing.date} ${beijing.time}`;
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = (): void => {
      cleanup();
      resolve("SIGINT");
    };
    const onSigterm = (): void => {
      cleanup();
      resolve("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

function printHelp(): void {
  console.log(`cerebellum-daemon - 闹钟矩阵守护（到点用真实数据跑 SOP → 大脑研判 → 推送）

用法:
  npm run cerebellum:dev                       # 常驻：每分钟检查到点的节点并出研判
  npm run cerebellum:dev -- --list             # 列出全部闹钟节点（标注哪些走深度研究）
  npm run cerebellum:dev -- --fire pre_market_plan   # 立刻手动触发某个节点（验证用）
  npm run cerebellum:dev -- --fire-all               # 把今天该触发的所有节点按时间顺序补跑一遍并推送（用当前实时行情，带未来函数）
  npm run cerebellum:dev -- --replay-day 2026-06-22  # 忠实重演某天：每个节点只看该时点前的信息（无未来函数）+ 推送

说明:
  到点时读真实模拟盘账户+行情+技术指标+指数（消息类节点还会联网检索），把该节点 SOP 喂给大脑出研判并推送。
  deep_review（20:30 深度复盘）在配置了 TradingAgents-CN 时改走多智能体深度研究（逐只持仓）。
  需要真实 BRAIN_PROVIDER（如 dashscope）才有真分析；mock 只出占位文本。
  只产出待人工复核的建议：不下单、不写账户、不接真实券商。
  盘中异动盯盘请同时跑：npm run sentinel:dev -- --live --wake-brain
  或一条命令全开：npm start（飞书对话 + 盘中哨兵 + 闹钟矩阵）。
`);
}

export class CerebellumDaemonCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebellumDaemonCliError";
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof CerebellumDaemonCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  });
}
