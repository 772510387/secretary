import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  redactNotificationEvent,
  redactNotificationText,
  type NotificationDeliveryResult,
  type NotificationEvent,
  type NotificationSeverity,
} from "../../domain/notification/index.js";
import type { ExternalNotificationNotifier } from "./notifier.js";
import type {
  WebhookFetchInit,
  WebhookFetchLike,
  WebhookFetchResponse,
} from "./webhook-notifier.js";

export interface WeComBotNotifierOptions {
  /** Full WeCom group-bot webhook URL (including `?key=...`). */
  webhookUrl?: string;
  /** Just the bot key; the standard WeCom webhook URL is built from it. */
  key?: string;
  /** Message format. WeCom markdown supports colored severity tags. Defaults to markdown. */
  msgType?: "markdown" | "text";
  /** Severities allowed to be pushed to the group. Defaults to watch/warning/critical (ADR). */
  severityAllowlist?: readonly NotificationSeverity[];
  fetchImpl?: WebhookFetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

interface WeComResponseBody {
  errcode?: unknown;
  errmsg?: unknown;
}

const WECOM_WEBHOOK_BASE = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEVERITY_ALLOWLIST: readonly NotificationSeverity[] = [
  "watch",
  "warning",
  "critical",
];
// WeCom caps markdown/text content at 4096 bytes; stay well under to leave room for tags.
const MAX_CONTENT_LENGTH = 2048;

/**
 * One-way push notifier for WeCom (Enterprise WeChat) group bots.
 *
 * Sends a de-identified short summary of a NotificationEvent to a group-bot
 * webhook. Per the WeChat notification ADR it only pushes a brief summary
 * (severity / target / summary / recommended action), never the full research
 * body, account details, or secrets, and defaults to watch/warning/critical only.
 * It is a notifier, not a command channel: it cannot trigger trades, account
 * writes, rule overrides, or tool execution.
 */
export class WeComBotNotifier implements ExternalNotificationNotifier {
  readonly channel = "wechat" as const;

  private readonly url: string;
  private readonly msgType: "markdown" | "text";
  private readonly severityAllowlist: ReadonlySet<NotificationSeverity>;
  private readonly fetchImpl: WebhookFetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: WeComBotNotifierOptions) {
    this.url = resolveWeComUrl(options);
    this.msgType = options.msgType ?? "markdown";
    this.severityAllowlist = new Set(
      options.severityAllowlist ?? DEFAULT_SEVERITY_ALLOWLIST,
    );
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  async notify(eventInput: NotificationEvent): Promise<NotificationDeliveryResult> {
    const event = notificationEventSchema.parse(eventInput);

    if (!this.severityAllowlist.has(event.severity)) {
      return notificationDeliveryResultSchema.parse({
        eventId: event.eventId,
        channel: this.channel,
        status: "skipped",
        deliveredAt: this.isoNow(),
        output: `wecom_skipped severity=${event.severity} not in allowlist`,
      });
    }

    const content = this.buildContent(event);
    const body = JSON.stringify(this.buildPayload(content));

    try {
      const response = await this.fetchWithTimeout(body);
      const text = await response.text();

      if (!response.ok) {
        return this.failed(event, `wecom_http_error: ${response.status} ${response.statusText ?? ""}`.trim());
      }

      const parsed = parseWeComResponse(text);

      if (parsed.errcode !== 0) {
        return this.failed(event, weComErrorMessage(parsed));
      }

      return notificationDeliveryResultSchema.parse({
        eventId: event.eventId,
        channel: this.channel,
        status: "sent",
        deliveredAt: this.isoNow(),
        output: `wecom_sent errcode=0 msgtype=${this.msgType}`,
      });
    } catch (error) {
      return this.failed(event, errorToMessage(error, this.timeoutMs));
    }
  }

  private buildPayload(content: string): Record<string, unknown> {
    if (this.msgType === "text") {
      return { msgtype: "text", text: { content } };
    }

    return { msgtype: "markdown", markdown: { content } };
  }

  private buildContent(eventInput: NotificationEvent): string {
    const event = redactNotificationEvent(eventInput);
    const target = formatTarget(event);

    const lines =
      this.msgType === "markdown"
        ? [
            `**${severityColorTag(event.severity)}** Secretary 盘面提醒`,
            target ? `> 标的：${target}` : undefined,
            `> 摘要：${event.summary}`,
            `> 建议：${event.recommendedAction}`,
            `> 来源：${formatSource(event)}`,
            `> 时间：${event.occurredAt}`,
          ]
        : [
            `[${event.severity.toUpperCase()}] Secretary 盘面提醒`,
            target ? `标的：${target}` : undefined,
            `摘要：${event.summary}`,
            `建议：${event.recommendedAction}`,
            `来源：${formatSource(event)}`,
            `时间：${event.occurredAt}`,
          ];

    return redactNotificationText(lines.filter(Boolean).join("\n")).slice(0, MAX_CONTENT_LENGTH);
  }

  private async fetchWithTimeout(body: string): Promise<WebhookFetchResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const init: WebhookFetchInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    };

    try {
      return await this.fetchImpl(this.url, init);
    } finally {
      clearTimeout(timeout);
    }
  }

  private failed(event: NotificationEvent, message: string): NotificationDeliveryResult {
    return notificationDeliveryResultSchema.parse({
      eventId: event.eventId,
      channel: this.channel,
      status: "failed",
      deliveredAt: this.isoNow(),
      error: redactKey(message).slice(0, 1000),
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new WeComBotNotifierError("WeComBotNotifier now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

function resolveWeComUrl(options: WeComBotNotifierOptions): string {
  const raw = options.webhookUrl ?? (options.key ? `${WECOM_WEBHOOK_BASE}?key=${options.key}` : undefined);

  if (!raw) {
    throw new WeComBotNotifierError("WeComBotNotifier requires a webhookUrl or key");
  }

  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new WeComBotNotifierError("WeComBotNotifier webhookUrl is not a valid URL", {
      cause: error,
    });
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WeComBotNotifierError("WeComBotNotifier webhookUrl must use http or https");
  }

  if (!parsed.searchParams.get("key")) {
    throw new WeComBotNotifierError("WeComBotNotifier webhookUrl must include a bot key");
  }

  return parsed.toString();
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!Number.isInteger(value) || value <= 0) {
    throw new WeComBotNotifierError("WeComBotNotifier timeoutMs must be a positive integer");
  }

  return value;
}

function parseWeComResponse(text: string): WeComResponseBody {
  if (text.trim() === "") {
    // WeCom always returns a JSON body on success; an empty body is unexpected.
    return { errcode: -1, errmsg: "empty response body" };
  }

  try {
    const parsed = JSON.parse(text) as unknown;

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { errcode: -1, errmsg: "response was not a JSON object" };
    }

    return parsed as WeComResponseBody;
  } catch {
    return { errcode: -1, errmsg: "response was not valid JSON" };
  }
}

function weComErrorMessage(parsed: WeComResponseBody): string {
  const code = typeof parsed.errcode === "number" ? parsed.errcode : "unknown";
  const message = typeof parsed.errmsg === "string" ? parsed.errmsg : "no message";

  if (code === 45009) {
    return `wecom_rate_limited: errcode=${code} ${message}`;
  }

  if (code === 93000) {
    return `wecom_invalid_webhook: errcode=${code} ${message}`;
  }

  return `wecom_send_failed: errcode=${code} ${message}`;
}

function errorToMessage(error: unknown, timeoutMs: number): string {
  if (isAbortError(error)) {
    return `wecom_timeout: request timed out after ${timeoutMs}ms`;
  }

  if (error instanceof WeComBotNotifierError) {
    return error.message;
  }

  return `wecom_request_failed: ${error instanceof Error ? error.message : String(error)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

function severityColorTag(severity: NotificationSeverity): string {
  // WeCom markdown color names: info(green) / comment(grey) / warning(red).
  const color =
    severity === "critical" || severity === "warning"
      ? "warning"
      : severity === "watch"
        ? "comment"
        : "info";

  return `<font color="${color}">${severity.toUpperCase()}</font>`;
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

function redactKey(value: string): string {
  return value.replace(/key=[^&\s]+/gi, "key=[redacted]");
}

function defaultFetch(input: string, init?: WebhookFetchInit): Promise<WebhookFetchResponse> {
  return globalThis.fetch(input, init) as Promise<WebhookFetchResponse>;
}

export class WeComBotNotifierError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WeComBotNotifierError";
  }
}
