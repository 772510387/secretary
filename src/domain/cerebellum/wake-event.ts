import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../shared/index.js";
import type { AgentMessage } from "../brain/index.js";
import { cerebellumAlarmTypeSchema, type CerebellumAlarmType } from "./schemas.js";

/**
 * A1 — the cerebellum→brain "neural impulse" (borrowed from openclaw's systemEvent).
 *
 * Today the resident daemon wakes the brain three different ways by direct calls
 * (a fixed alarm node, a sentinel red-line, the 10-min patrol). This is the single
 * typed envelope they all collapse into, so the hand-off is uniform, auditable, and
 * rate-limitable in ONE place. It is pure plumbing: the cerebellum (code) decides
 * WHEN to fire and WHAT data is ready; the brain only reacts to what arrives.
 *
 * Note this does NOT move scheduling into the LLM — the 17-node matrix stays a code
 * timer precisely because openclaw's LLM cron proved unreliable (jobs silently
 * lapsed and the instructions they carried got forgotten). The envelope only
 * standardises the wake, not the decision of when to wake.
 */
export const cerebellumWakeSourceSchema = z.enum([
  "alarm_matrix",
  "market_sentinel",
  "index_risk_radar",
  "silent_patrol",
  "manual",
]);

export const cerebellumWakeKindSchema = z.enum([
  "scheduled_node",
  "redline",
  "patrol",
  "system_event",
]);

/** How urgently the brain should act: interrupt a running turn vs. wait for idle. */
export const cerebellumWakeModeSchema = z.enum(["now", "next-idle"]);

export const cerebellumWakeSeveritySchema = z.enum(["info", "watch", "warning", "critical"]);

export const cerebellumWakeEventSchema = z
  .object({
    wakeId: identifierSchema,
    occurredAt: isoDateTimeSchema,
    source: cerebellumWakeSourceSchema,
    kind: cerebellumWakeKindSchema,
    /** The neural-impulse text handed to the brain (openclaw systemEvent.text analogue). */
    text: z.string().trim().min(1).max(2000),
    /** Present when kind=scheduled_node: which fixed alarm node fired. */
    alarmType: cerebellumAlarmTypeSchema.optional(),
    /** Beijing wall-clock label, e.g. "08:30". */
    beijingTime: z.string().trim().regex(/^\d{2}:\d{2}$/).optional(),
    /** Whether the cerebellum already prepared the data the brain will need. */
    dataReady: z.boolean().default(false),
    wakeMode: cerebellumWakeModeSchema.default("next-idle"),
    severity: cerebellumWakeSeveritySchema.default("info"),
    payload: jsonValueSchema.default({}),
    correlationId: identifierSchema.optional(),
  })
  .strict();

export type CerebellumWakeSource = z.infer<typeof cerebellumWakeSourceSchema>;
export type CerebellumWakeKind = z.infer<typeof cerebellumWakeKindSchema>;
export type CerebellumWakeMode = z.infer<typeof cerebellumWakeModeSchema>;
export type CerebellumWakeSeverity = z.infer<typeof cerebellumWakeSeveritySchema>;
export type CerebellumWakeEvent = z.infer<typeof cerebellumWakeEventSchema>;

export interface BuildCerebellumWakeEventInput {
  source: CerebellumWakeSource;
  kind: CerebellumWakeKind;
  text: string;
  occurredAt: Date | string;
  wakeId?: string;
  alarmType?: CerebellumAlarmType;
  beijingTime?: string;
  dataReady?: boolean;
  wakeMode?: CerebellumWakeMode;
  severity?: CerebellumWakeSeverity;
  payload?: z.infer<typeof jsonValueSchema>;
  correlationId?: string;
}

export function buildCerebellumWakeEvent(input: BuildCerebellumWakeEventInput): CerebellumWakeEvent {
  const occurredAt = normalizeIso(input.occurredAt);
  const wakeId = (input.wakeId ?? `wake-${input.source}-${Date.parse(occurredAt)}`).slice(0, 128);

  return cerebellumWakeEventSchema.parse({
    wakeId,
    occurredAt,
    source: input.source,
    kind: input.kind,
    text: input.text,
    alarmType: input.alarmType,
    beijingTime: input.beijingTime,
    dataReady: input.dataReady ?? false,
    wakeMode: input.wakeMode ?? (input.kind === "redline" ? "now" : "next-idle"),
    severity: input.severity ?? (input.kind === "redline" ? "critical" : "info"),
    payload: input.payload ?? {},
    correlationId: input.correlationId,
  });
}

/** Renders a wake event as a steering message to inject into a running brain turn (B1). */
export function wakeEventToSteeringMessage(event: CerebellumWakeEvent): AgentMessage {
  const tag = event.beijingTime ? `${event.source}/${event.kind}@${event.beijingTime}` : `${event.source}/${event.kind}`;
  return {
    role: "system",
    content: `【小脑事件 ${tag}】${event.text}`,
  };
}

export interface CerebellumWakeDispatchDeps {
  /** Wake the (idle) brain to think/act on this event — e.g. run an SOP / agentic turn. */
  wakeBrain?: (event: CerebellumWakeEvent) => Promise<void> | void;
  /** Steer an in-flight brain turn (B1). Used for `now`/redline wakes. */
  steer?: (event: CerebellumWakeEvent) => void;
  /** Audit hook fired for EVERY wake regardless of routing. */
  onWake?: (event: CerebellumWakeEvent) => void;
}

export interface CerebellumWakeDispatchResult {
  wakeId: string;
  routed: "wake_brain" | "steer" | "logged";
  steered: boolean;
  woke: boolean;
}

/**
 * Routes a wake event. `now` wakes (red-lines) steer any in-flight turn AND wake the
 * brain if idle; everything else just wakes the brain. Always audits. Pure routing —
 * no scheduling decisions live here.
 */
export async function dispatchCerebellumWake(
  event: CerebellumWakeEvent,
  deps: CerebellumWakeDispatchDeps,
): Promise<CerebellumWakeDispatchResult> {
  deps.onWake?.(event);

  let steered = false;
  let woke = false;

  if (event.wakeMode === "now" && deps.steer) {
    deps.steer(event);
    steered = true;
  }

  if (deps.wakeBrain) {
    await deps.wakeBrain(event);
    woke = true;
  }

  const routed: CerebellumWakeDispatchResult["routed"] = woke
    ? "wake_brain"
    : steered
      ? "steer"
      : "logged";

  return { wakeId: event.wakeId, routed, steered, woke };
}

function normalizeIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CerebellumWakeError(`Invalid wake occurredAt: ${String(value)}`);
  }
  return parsed.toISOString();
}

export class CerebellumWakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebellumWakeError";
  }
}
