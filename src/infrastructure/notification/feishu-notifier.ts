import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  redactNotificationEvent,
  redactNotificationText,
  type NotificationDeliveryResult,
  type NotificationEvent,
  type NotificationSeverity,
} from "../../domain/notification/index.js";
import { beijingDateTimeLabel } from "../../domain/shared/index.js";
import type { ExternalNotificationNotifier } from "./notifier.js";

export interface FeishuPushMessage {
  /** Feishu open_id of the recipient. */
  receiveId: string;
  text: string;
}

/** Sends one proactive Feishu text message. Injected so the core stays SDK-free + testable. */
export type FeishuMessageSender = (message: FeishuPushMessage) => Promise<void>;

export interface FeishuNotifierOptions {
  sender: FeishuMessageSender;
  /** open_ids to push to. Empty → every notification is skipped (no target). */
  recipients: readonly string[];
  severityAllowlist?: readonly NotificationSeverity[];
  now?: () => Date;
}

// Alarm summaries are usually info-level, so info is allowed in the default allowlist.
const DEFAULT_SEVERITY_ALLOWLIST: readonly NotificationSeverity[] = [
  "info",
  "watch",
  "warning",
  "critical",
];
const MAX_FEISHU_MESSAGE_LENGTH = 1800;
const FEISHU_CHUNK_PREFIX_RESERVE = 32;

/**
 * Proactive one-way push notifier for Feishu (Lark) direct messages.
 *
 * Pushes a de-identified NotificationEvent report to each configured open_id via an
 * injected sender (the daemon wires it to the Lark `im.message.create` API). Long
 * reports are split into ordered text chunks so the operator sees the full alarm
 * analysis instead of a truncated summary. It is a notifier, not a command channel:
 * it cannot trigger trades, account writes, rule overrides, or tool execution.
 */
export class FeishuNotifier implements ExternalNotificationNotifier {
  readonly channel = "feishu" as const;

  private readonly sender: FeishuMessageSender;
  private readonly recipients: readonly string[];
  private readonly severityAllowlist: ReadonlySet<NotificationSeverity>;
  private readonly now: () => Date;

  constructor(options: FeishuNotifierOptions) {
    this.sender = options.sender;
    this.recipients = options.recipients;
    this.severityAllowlist = new Set(options.severityAllowlist ?? DEFAULT_SEVERITY_ALLOWLIST);
    this.now = options.now ?? (() => new Date());
  }

  async notify(eventInput: NotificationEvent): Promise<NotificationDeliveryResult> {
    const event = notificationEventSchema.parse(eventInput);

    if (!this.severityAllowlist.has(event.severity)) {
      return this.result(event, "skipped", {
        output: `feishu_skipped severity=${event.severity} not in allowlist`,
      });
    }

    if (this.recipients.length === 0) {
      return this.result(event, "skipped", { output: "feishu_skipped no recipients configured" });
    }

    const messages = this.buildMessages(event);
    let sentMessages = 0;
    let fullySentRecipients = 0;
    const failures: string[] = [];

    for (const receiveId of this.recipients) {
      let sentForRecipient = 0;

      for (let index = 0; index < messages.length; index += 1) {
        try {
          await this.sender({ receiveId, text: messages[index]! });
          sentMessages += 1;
          sentForRecipient += 1;
        } catch (error) {
          failures.push(`${receiveId}#${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }

      if (sentForRecipient === messages.length) {
        fullySentRecipients += 1;
      }
    }

    if (sentMessages === 0) {
      return this.result(event, "failed", {
        error: `feishu_send_failed: ${failures.join("; ")}`.slice(0, 1000),
      });
    }

    return this.result(event, "sent", {
      output:
        failures.length > 0
          ? `feishu_sent recipients=${fullySentRecipients}/${this.recipients.length} chunks=${messages.length} messages=${sentMessages} (partial)`
          : `feishu_sent recipients=${fullySentRecipients} chunks=${messages.length}`,
    });
  }

  private buildMessages(eventInput: NotificationEvent): string[] {
    const event = redactNotificationEvent(eventInput);
    const target = formatTarget(event);
    const lines = [
      `【${event.severity.toUpperCase()}】Secretary 盘面提醒`,
      target ? `标的：${target}` : undefined,
      `摘要：${event.summary}`,
      `建议：${event.recommendedAction}`,
      `来源：${formatSource(event)}`,
      `时间：${beijingDateTimeLabel(event.occurredAt)}`,
    ];
    return chunkFeishuText(redactNotificationText(lines.filter(Boolean).join("\n")));
  }

  private result(
    event: NotificationEvent,
    status: "sent" | "skipped" | "failed",
    extra: { output?: string; error?: string },
  ): NotificationDeliveryResult {
    return notificationDeliveryResultSchema.parse({
      eventId: event.eventId,
      channel: this.channel,
      status,
      deliveredAt: this.isoNow(),
      ...extra,
    });
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new FeishuNotifierError("FeishuNotifier now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

function chunkFeishuText(text: string): string[] {
  const normalized = text.trim();

  if (normalized.length <= MAX_FEISHU_MESSAGE_LENGTH) {
    return [normalized];
  }

  const bodyMax = MAX_FEISHU_MESSAGE_LENGTH - FEISHU_CHUNK_PREFIX_RESERVE;
  const bodies: string[] = [];
  let rest = normalized;

  while (rest.length > bodyMax) {
    const cut = findChunkCut(rest, bodyMax);
    bodies.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) {
    bodies.push(rest);
  }

  return bodies.map((body, index) => `（${index + 1}/${bodies.length}）\n${body}`);
}

function findChunkCut(text: string, max: number): number {
  const floor = Math.floor(max * 0.6);

  for (const marker of ["\n", "。", "；", "，", " "] as const) {
    const index = text.lastIndexOf(marker, max);

    if (index >= floor) {
      return index + marker.length;
    }
  }

  return max;
}

function formatSource(event: NotificationEvent): string {
  return event.source.id ? `${event.source.type}:${event.source.id}` : event.source.type;
}

function formatTarget(event: NotificationEvent): string | undefined {
  if (event.target.symbol) {
    const market = event.target.market ? `${event.target.market}:` : "";
    const name = event.target.name ? ` ${event.target.name}` : "";
    return `${market}${event.target.symbol}${name}`;
  }
  if (event.target.id) {
    return `${event.target.type}:${event.target.id}`;
  }
  return event.target.type === "system" ? undefined : event.target.type;
}

export class FeishuNotifierError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuNotifierError";
  }
}
