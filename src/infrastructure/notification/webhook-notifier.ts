import {
  notificationDeliveryResultSchema,
  notificationEventSchema,
  redactNotificationEvent,
  redactNotificationText,
  type NotificationDeliveryResult,
  type NotificationEvent,
} from "../../domain/notification/index.js";
import type { ExternalNotificationNotifier } from "./notifier.js";

export interface WebhookNotifierOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl?: WebhookFetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

export interface WebhookFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface WebhookFetchHeaders {
  get(name: string): string | null;
}

export interface WebhookFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: WebhookFetchHeaders;
  text(): Promise<string>;
}

export type WebhookFetchLike = (
  input: string,
  init?: WebhookFetchInit,
) => Promise<WebhookFetchResponse>;

interface WebhookResponseBody {
  ok?: unknown;
  deliveryId?: unknown;
  message?: unknown;
  error?: unknown;
}

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export class WebhookNotifier implements ExternalNotificationNotifier {
  readonly channel = "webhook" as const;

  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: WebhookFetchLike;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: WebhookNotifierOptions) {
    this.url = normalizeWebhookUrl(options.url);
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? defaultFetch;
    this.timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    this.now = options.now ?? (() => new Date());
  }

  async notify(eventInput: NotificationEvent): Promise<NotificationDeliveryResult> {
    const event = notificationEventSchema.parse(eventInput);
    const redactedEvent = redactNotificationEvent(event);
    const body = JSON.stringify({
      event: redactedEvent,
      delivery: {
        channel: this.channel,
        requestedAt: this.isoNow(),
      },
    });

    try {
      const response = await this.fetchWithTimeout(body);
      const text = await response.text();

      if (!response.ok) {
        return this.failed(event, this.errorForStatus(response, text));
      }

      const parsed = parseWebhookResponse(text);

      if (parsed.ok === false) {
        return this.failed(event, `webhook_bad_response: ${responseMessage(parsed)}`);
      }

      return notificationDeliveryResultSchema.parse({
        eventId: event.eventId,
        channel: this.channel,
        status: "sent",
        deliveredAt: this.isoNow(),
        output: buildSuccessOutput(response, parsed),
      });
    } catch (error) {
      return this.failed(event, errorToWebhookMessage(error, this.timeoutMs));
    }
  }

  private async fetchWithTimeout(body: string): Promise<WebhookFetchResponse> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new WebhookNotifierTimeoutError(`WebhookNotifier request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });
    const request = this.fetchImpl(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.headers,
      },
      body,
      signal: controller.signal,
    });

    try {
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw new WebhookNotifierTimeoutError(`WebhookNotifier request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }

      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private errorForStatus(response: WebhookFetchResponse, text: string): string {
    const statusLabel = `${response.status} ${response.statusText ?? ""}`.trim();
    const detail = responseDetail(text);

    if (response.status === 401 || response.status === 403) {
      return `webhook_auth_failed: ${statusLabel}${detail}`;
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const retryText = retryAfterMs === undefined ? "" : ` retryAfterMs=${retryAfterMs}`;

      return `webhook_rate_limited: ${statusLabel}${retryText}${detail}`;
    }

    if (response.status >= 500) {
      return `webhook_server_error: ${statusLabel}${detail}`;
    }

    return `webhook_request_failed: ${statusLabel}${detail}`;
  }

  private failed(event: NotificationEvent, message: string): NotificationDeliveryResult {
    return notificationDeliveryResultSchema.parse({
      eventId: event.eventId,
      channel: this.channel,
      status: "failed",
      deliveredAt: this.isoNow(),
      error: safeOutput(message, 1000),
    });
  }

  private isoNow(): string {
    const value = this.now();

    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new NotificationWebhookError("WebhookNotifier now() returned an invalid Date");
    }

    return value.toISOString();
  }
}

function defaultFetch(input: string, init?: WebhookFetchInit): Promise<WebhookFetchResponse> {
  return globalThis.fetch(input, init) as Promise<WebhookFetchResponse>;
}

function normalizeWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new NotificationWebhookError("WebhookNotifier url must use http or https");
    }

    return parsed.toString();
  } catch (error) {
    if (error instanceof NotificationWebhookError) {
      throw error;
    }

    throw new NotificationWebhookError(`Invalid WebhookNotifier url: ${url}`, {
      cause: error,
    });
  }
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;

  if (!Number.isInteger(value) || value <= 0) {
    throw new NotificationWebhookError("WebhookNotifier timeoutMs must be a positive integer");
  }

  return value;
}

function parseWebhookResponse(text: string): WebhookResponseBody {
  if (text.trim() === "") {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new NotificationWebhookError("webhook_bad_response: response was not valid JSON", {
      cause: error,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NotificationWebhookError("webhook_bad_response: response JSON must be an object");
  }

  return parsed as WebhookResponseBody;
}

function buildSuccessOutput(
  response: WebhookFetchResponse,
  parsed: WebhookResponseBody,
): string {
  const parts = [`webhook_sent status=${response.status}`];

  if (typeof parsed.deliveryId === "string" && parsed.deliveryId.trim() !== "") {
    parts.push(`deliveryId=${parsed.deliveryId.trim()}`);
  }

  if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
    parts.push(`message=${parsed.message.trim()}`);
  }

  return safeOutput(parts.join(" "), 2000);
}

function responseDetail(text: string): string {
  if (text.trim() === "") {
    return "";
  }

  try {
    const parsed = JSON.parse(text) as WebhookResponseBody;
    const message = responseMessage(parsed);

    return message === "no message" ? "" : ` - ${message}`;
  } catch {
    return ` - ${text.slice(0, 200)}`;
  }
}

function responseMessage(parsed: WebhookResponseBody): string {
  if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
    return parsed.message.trim();
  }

  if (typeof parsed.error === "string" && parsed.error.trim() !== "") {
    return parsed.error.trim();
  }

  return "no message";
}

function parseRetryAfterMs(headers: WebhookFetchHeaders | undefined): number | undefined {
  const value = headers?.get("retry-after") ?? headers?.get("Retry-After");

  if (!value) {
    return undefined;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const date = Date.parse(value);

  if (Number.isNaN(date)) {
    return undefined;
  }

  return Math.max(0, date - Date.now());
}

function errorToWebhookMessage(error: unknown, timeoutMs: number): string {
  if (error instanceof WebhookNotifierTimeoutError || isAbortError(error)) {
    return `webhook_timeout: request timed out after ${timeoutMs}ms`;
  }

  if (error instanceof NotificationWebhookError) {
    return error.message;
  }

  return `webhook_request_failed: ${error instanceof Error ? error.message : String(error)}`;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /aborted|abort/i.test(error.message))
  );
}

function safeOutput(value: string, maxLength: number): string {
  return redactWebhookText(value).slice(0, maxLength);
}

function redactWebhookText(input: string): string {
  return redactNotificationText(input)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(authorization|x-api-key)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
}

export class NotificationWebhookError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NotificationWebhookError";
  }
}

class WebhookNotifierTimeoutError extends NotificationWebhookError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebhookNotifierTimeoutError";
  }
}
