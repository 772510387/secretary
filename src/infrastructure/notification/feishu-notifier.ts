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
const MAX_CONTENT_LENGTH = 2048;

/**
 * Proactive one-way push notifier for Feishu (Lark) direct messages.
 *
 * Pushes a de-identified short summary of a NotificationEvent (severity / target /
 * summary / recommended action) to each configured open_id via an injected sender
 * (the daemon wires it to the Lark `im.message.create` API). It only sends a brief
 * redacted summary — never the full research body, account details, or secrets — and
 * it is a notifier, not a command channel: it cannot trigger trades, account writes,
 * rule overrides, or tool execution.
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

    const text = this.buildContent(event);
    let sent = 0;
    const failures: string[] = [];

    for (const receiveId of this.recipients) {
      try {
        await this.sender({ receiveId, text });
        sent += 1;
      } catch (error) {
        failures.push(`${receiveId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (sent === 0) {
      return this.result(event, "failed", {
        error: `feishu_send_failed: ${failures.join("; ")}`.slice(0, 1000),
      });
    }

    return this.result(event, "sent", {
      output:
        failures.length > 0
          ? `feishu_sent recipients=${sent}/${this.recipients.length} (partial)`
          : `feishu_sent recipients=${sent}`,
    });
  }

  private buildContent(eventInput: NotificationEvent): string {
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
    return redactNotificationText(lines.filter(Boolean).join("\n")).slice(0, MAX_CONTENT_LENGTH);
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
