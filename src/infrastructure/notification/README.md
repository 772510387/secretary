# Notification Infrastructure

Notification adapters. U6 implemented local console/file output; R4-1 adds an external webhook adapter with injectable fetch.

## Current Interfaces

```ts
import {
  ConsoleNotifier,
  FileNotifier,
  NotificationRouter,
  WebhookNotifier,
  createNotificationLogPath,
} from "./src/infrastructure/notification/index.js";

const consoleNotifier = new ConsoleNotifier();
consoleNotifier.notify(event);

const fileNotifier = new FileNotifier({
  filePath: createNotificationLogPath("memory/logs", event.occurredAt),
});
fileNotifier.notify(event);

const webhookNotifier = new WebhookNotifier({
  url: "https://example.invalid/secretary-webhook",
  fetchImpl: async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }),
});
await webhookNotifier.notify(event);

const router = new NotificationRouter({
  notifiers: {
    console: consoleNotifier,
    file: fileNotifier,
  },
  auditSink: async (auditEvent) => {
    // Append with AuditLogWriter or another audited store in runtime wiring.
    void auditEvent;
  },
});
await router.notify(event);
```

## Boundaries

- `ConsoleNotifier` formats one local line and writes through an injected sink or `console.log`.
- `FileNotifier` appends redacted `NotificationEvent` JSONL using `AtomicFileWriter`.
- `WebhookNotifier` posts a redacted `NotificationEvent` envelope to an external URL through injected or global fetch.
- `NotificationRouter` applies route policy and invokes injected notifiers. Defaults route only to `console` and `file`; external channels are disabled until explicitly configured.
- Critical notifications must have an `auditSink`; without one, router returns a failed dispatch instead of silently sending an unaudited critical alert.
- Webhook tests use mock fetch by default. Real network smoke requires `WEBHOOK_NOTIFIER_NETWORK=1` and `WEBHOOK_NOTIFIER_URL`.
- Webhook failures return `NotificationDeliveryResult.status="failed"` for timeout, 401/403, 429, 5xx, bad JSON and `{ ok: false }` responses.
- Webhook delivery results redact response text and never log request headers, tokens or full secrets.
- `wechat` remains a reserved channel name only; no real WeChat sender is implemented.
- R4-2 WeChat design is documented in `docs/architecture/decision-records/2026-06-15-wechat-notification-design.md`.
- A future `WechatNotifier` must accept credential references only, use mock fetch by default in tests, apply provider rate limits, degrade to console/file on failures, and never log tokens or full sensitive bodies.
- Notifiers do not call broker, do not write accounts, and do not place orders.
