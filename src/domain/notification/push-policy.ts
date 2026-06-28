import { type NotificationEvent } from "./schemas.js";

/**
 * Operator push gate (Boss preference, 2026-06-24).
 *
 * The resident daemons run a 3-second sentinel and a 10-minute silent patrol that
 * emit a large stream of intraday observations. The Boss does NOT want every one of
 * those pushed to an external channel (Feishu) — only three classes of event
 * are worth interrupting a human for. Everything else is still printed to the local
 * console / file log for audit, but is never sent externally.
 *
 *   1. executed_operation — what the system actually DID on the paper account
 *      (the deterministic 8% hard-stop force-close, or a funnel auto-paper fill).
 *      Tagged on the notification's metadata (autoClosed / autoPaper / executed /
 *      tradeExecuted). This is the "把你操作的跟操作逻辑讲清楚发给我" path.
 *   2. redline — a hard red-line breach. The sentinel emits cooldown-bounded red-lines
 *      for 1-minute ±2% moves, ±5% absolute moves, previous-high breakouts, 8% stop-loss,
 *      and the index radar emits ±1% / systemic moves. These should reach Feishu; low-
 *      urgency `watch` events (near observe price) stay local.
 *   3. scheduled_report — the daily secretary briefings and node reports
 *      (alarm-matrix nodes, the daily-funnel summaries, deep-review research).
 *
 * Suppressed (local log only): volume-price-radar, observe-price proximity, and normal
 * 10-minute silent patrol pulses with no anomaly.
 */
export type ExternalPushReason = "executed_operation" | "redline" | "scheduled_report";

/** Metadata flags that mark a notification as an executed paper operation. */
const OPERATION_METADATA_FLAGS = ["autoClosed", "autoPaper", "executed", "tradeExecuted"] as const;

/** Sources whose warning/critical events are hard red-lines worth an external push. */
const REDLINE_SOURCE_IDS: ReadonlySet<string> = new Set(["market-sentinel", "index-risk-radar"]);

/** Scheduled briefings / node reports that should still reach the operator. */
const SCHEDULED_REPORT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "alarm-matrix",
  "daily-funnel",
  "deep-review",
]);

/**
 * Classifies why an event is worth an external push, or `null` if it should stay in
 * the local log only. Pure and side-effect free.
 */
export function classifyExternalPush(event: NotificationEvent): ExternalPushReason | null {
  const metadata = event.metadata ?? {};

  if (OPERATION_METADATA_FLAGS.some((flag) => metadata[flag] === true)) {
    return "executed_operation";
  }

  if (
    (event.severity === "warning" || event.severity === "critical") &&
    event.source.id !== undefined &&
    REDLINE_SOURCE_IDS.has(event.source.id)
  ) {
    return "redline";
  }

  if (event.source.id !== undefined && SCHEDULED_REPORT_SOURCE_IDS.has(event.source.id)) {
    return "scheduled_report";
  }

  return null;
}

/**
 * Whether a notification should be delivered to external channels (Feishu).
 * Suppressed events are still expected to be logged locally by the caller.
 */
export function shouldPushToExternalChannels(event: NotificationEvent): boolean {
  return classifyExternalPush(event) !== null;
}
