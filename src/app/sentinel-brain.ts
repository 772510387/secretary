import { brainInputSchema, type BrainProvider } from "../domain/brain/index.js";
import type { CerebellumEvent } from "../domain/cerebellum/index.js";
import {
  notificationEventSchema,
  type NotificationEvent,
} from "../domain/notification/index.js";
import type { Position } from "../domain/portfolio/index.js";

export interface AnalyzeMarketAlertInput {
  event: CerebellumEvent;
  /** The held position for the symbol, if any (lets the brain weigh cost / stop-loss). */
  position?: Position;
}

export interface SentinelBrainDependencies {
  brainProvider: BrainProvider;
}

/**
 * Wakes the brain for ONE sentinel anomaly and returns a short zh judgement.
 *
 * This is the "踢醒大脑" half of the eye-brain split: the deterministic sentinel
 * only fires on a redline, and only then (per event, cooldown-bounded) does this
 * spend a model call to analyze the specific move. It is read-only — the brain
 * never trades, writes the account, or executes tools.
 */
export async function analyzeMarketAlert(
  input: AnalyzeMarketAlertInput,
  deps: SentinelBrainDependencies,
): Promise<string> {
  const { event, position } = input;
  const pct = event.changePct === undefined ? "未知" : `${(event.changePct * 100).toFixed(2)}%`;
  const held = position
    ? `当前持仓：成本 ${position.costPrice} 元，${position.quantity} 股（可卖 ${position.availableQuantity} 股）。`
    : "该标的为自选/观察，非持仓。";

  const brainInput = brainInputSchema.parse({
    requestId: `sentinel-${event.eventId}`.slice(0, 128),
    taskType: "user_query",
    prompt: [
      "【小脑指令：盘中异动唤醒】",
      `唤醒规则：底层守护脚本命中 ${event.eventType}，冷却键 ${event.cooldownKey}，因此唤醒大脑做一次短研判。`,
      "操作指令：",
      "1. 读取本次已注入的异动事实和持仓上下文。",
      "2. 判断是否触及防守底线、追高风险或自选股观察条件。",
      "3. 用 1-2 句给出明确研判与操作建议。",
      `异动事实：${event.message}（现价 ${event.currentPrice}，幅度 ${pct}）。`,
      held,
      "说清：可能的方向/风险，以及是否减仓或止损。",
      "直接给结论，别客套，控制在两句以内。",
    ].join("\n"),
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "markdown",
      toolPermissions: [],
    },
    createdAt: event.occurredAt,
  });

  const output = await deps.brainProvider.generate(brainInput);
  return output.summary;
}

/**
 * Upgrades a deterministic sentinel notification with the brain's judgement:
 * keeps the factual line as the summary (flagged 🔴) and puts the AI take in
 * `recommendedAction`. Falls back gracefully if the analysis is empty.
 */
export function enrichSentinelNotification(
  base: NotificationEvent,
  analysis: string,
): NotificationEvent {
  const trimmed = analysis.trim();

  if (!trimmed) {
    return base;
  }

  return notificationEventSchema.parse({
    ...base,
    summary: `🔴 ${base.summary}`.slice(0, 1000),
    recommendedAction: `AI研判：${trimmed}`.slice(0, 500),
    metadata: { ...asRecord(base.metadata), brainAnalyzed: true },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
