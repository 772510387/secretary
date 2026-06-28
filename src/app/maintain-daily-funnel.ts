import type { BrainProvider } from "../domain/brain/index.js";
import {
  buildDailyTradingPlan,
  type DailyTradingPlan,
  type PlanPendingOrder,
  type PlanWatchlistEntry,
} from "../domain/plan/index.js";
import {
  NOTIFICATION_SUMMARY_MAX_LENGTH,
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type { TradeIntentReviewProposal } from "../domain/memory/index.js";
import type { JsonValue } from "../domain/shared/index.js";
import {
  selectFunnelStage,
  type FunnelExecutionConstraints,
  type FunnelHolding,
} from "./select-funnel.js";

/** Minimal store surfaces (the real PlanMemoryStore / ProposalMemoryStore satisfy these). */
export interface PlanWriter {
  writePlan(plan: DailyTradingPlan): unknown;
}
export interface ProposalWriter {
  writeProposal(proposal: TradeIntentReviewProposal): unknown;
}
export interface FunnelNotifier {
  notify(event: NotificationEvent): unknown;
}

export interface MaintainDailyFunnelInput {
  alarmType: string;
  tradingDate: string;
  asOf: string;
  accountId: string;
  /** The refreshed 100 高关注池 snapshot (caller runs the deterministic screen). */
  watchlist100: PlanWatchlistEntry[];
  holdings: FunnelHolding[];
  autoPaper?: boolean;
  brainContext?: Record<string, JsonValue>;
  /** 观察池分类概览 (real signals) — fed to the model so selection rationale cites concrete signals. */
  poolOverview?: string;
  executionConstraints?: FunnelExecutionConstraints;
  shortlistSize?: number;
}

export interface MaintainDailyFunnelDeps {
  brainProvider: BrainProvider;
  planStore: PlanWriter;
  proposalStore: ProposalWriter;
  notifiers?: FunnelNotifier[];
}

export interface MaintainDailyFunnelResult {
  plan: DailyTradingPlan;
  proposals: TradeIntentReviewProposal[];
  degraded: boolean;
}

/**
 * Stage B+C of the daily funnel for ONE alarm node: the model selects the 10 潜力股 +
 * 待买/待卖 from the (already-refreshed) 100-pool and current holdings, then we persist a
 * DailyTradingPlan + the review-required proposals and push a summary to Feishu.
 *
 * This stays proposal-only: every emitted order is a review-required TradeIntentReviewProposal
 * (executable:false); NOTHING is executed here. An empty account is first-class — with no
 * holdings the model still proposes what to BUY from the funnel (not "nothing to review").
 */
export async function maintainDailyFunnel(
  input: MaintainDailyFunnelInput,
  deps: MaintainDailyFunnelDeps,
): Promise<MaintainDailyFunnelResult> {
  const selection = await selectFunnelStage(
    {
      accountId: input.accountId,
      asOf: input.asOf,
      watchlist100: input.watchlist100,
      holdings: input.holdings,
      brainContext: input.brainContext,
      poolOverview: input.poolOverview,
      executionConstraints: input.executionConstraints,
      shortlistSize: input.shortlistSize,
    },
    { brainProvider: deps.brainProvider },
  );

  const pendingOrders: PlanPendingOrder[] = selection.proposals.map((proposal) => ({
    proposalId: proposal.proposalId,
    symbol: proposal.symbol,
    market: proposal.market,
    side: proposal.side === "SELL" ? "SELL" : "BUY",
    status: "pending_review",
    rationale: proposal.rationale.slice(0, 500),
  }));

  const plan = buildDailyTradingPlan({
    tradingDate: input.tradingDate,
    accountId: input.accountId,
    alarmType: input.alarmType,
    generatedAt: input.asOf,
    autoPaper: input.autoPaper ?? false,
    watchlist100: input.watchlist100,
    shortlist10: selection.shortlist10,
    pendingOrders,
  });

  deps.planStore.writePlan(plan);
  for (const proposal of selection.proposals) {
    deps.proposalStore.writeProposal(proposal);
  }

  const event = buildFunnelNotification(plan, selection.proposals, input.holdings.length);
  for (const notifier of deps.notifiers ?? []) {
    try {
      notifier.notify(event);
    } catch {
      // a push failure must never break the funnel
    }
  }

  return { plan, proposals: selection.proposals, degraded: selection.degraded };
}

function buildFunnelNotification(
  plan: DailyTradingPlan,
  proposals: TradeIntentReviewProposal[],
  holdingCount: number,
): NotificationEvent {
  const buys = proposals.filter((proposal) => proposal.side === "BUY");
  const sells = proposals.filter((proposal) => proposal.side === "SELL");
  // autoPaper=false means this node only PLANS (待买卖) — e.g. pre-open / lunch / post-close,
  // when A股 can't trade. Don't word it as "执行" then.
  const willExecute = plan.safety.autoPaper;
  const verb = willExecute ? "选择执行" : "选择待买/待卖（本节点不成交）";
  const orderLine =
    proposals.length === 0
      ? "模型未选择买卖操作；后端无模拟成交。"
      : `模型${verb}：买入 ${buys.length} 笔、卖出 ${sells.length} 笔；${proposals
          .map(formatProposalSummary)
          .join("；")}`;
  // 潜力股名单 + 逐只选股理由 — the boss asked "why these stocks"; surface it, don't hide behind a count.
  const shortlistLine =
    plan.shortlist10.length === 0
      ? ""
      : `\n潜力股(为何入选)：${plan.shortlist10
          .slice(0, SHORTLIST_PUSH_LIMIT)
          .map((entry) => `${entry.name}(${entry.symbol})｜${clip(entry.rationale, 60)}`)
          .join("；")}${plan.shortlist10.length > SHORTLIST_PUSH_LIMIT ? `…等${plan.shortlist10.length}支` : ""}`;

  return notificationEventSchema.parse({
    eventId: `funnel-${plan.tradingDate}-${plan.alarmType}-seq${plan.nodeSequence}`.slice(0, 128),
    occurredAt: plan.generatedAt,
    severity: "info",
    source: { type: "scheduler", id: "daily-funnel" },
    target: { type: "system" },
    summary: clip(
      `【选股漏斗·${plan.alarmType}】候选 ${plan.shortlist10.length} 支；持仓 ${holdingCount} 只；${orderLine}${shortlistLine}`,
      NOTIFICATION_SUMMARY_MAX_LENGTH,
    ),
    recommendedAction:
      proposals.length === 0
        ? "本节点无买卖操作。"
        : willExecute
          ? "后端已按现金、仓位、T+1、100股、主板规则成交并写入账本。"
          : "非 A 股连续交易时段，先出待买卖清单，开盘后自动成交。",
    channels: ["feishu"],
    metadata: {
      funnel: true,
      planId: plan.planId,
      nodeSequence: plan.nodeSequence,
      // Full 潜力股名单+理由 in metadata so a richer renderer can show all, even when summary is clipped.
      shortlist: plan.shortlist10.map((entry) => ({
        symbol: entry.symbol,
        name: entry.name,
        rank: entry.rank ?? null,
        rationale: entry.rationale,
      })),
    },
  });
}

/** How many 潜力股 to inline into the push summary (the rest go to metadata.shortlist). */
const SHORTLIST_PUSH_LIMIT = 6;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function formatProposalSummary(proposal: TradeIntentReviewProposal): string {
  const name = proposal.name ? ` ${proposal.name}` : "";
  const sized =
    proposal.quantity !== undefined && proposal.limitPrice !== undefined
      ? ` ${proposal.quantity}股@${proposal.limitPrice}`
      : "";
  return `${proposal.side} ${proposal.symbol}${name}${sized}：${proposal.rationale}`;
}
