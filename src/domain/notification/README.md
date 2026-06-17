# Notification Domain

负责告警、通知内容、冷却和去重策略。

## 需要实现

- `NotificationEvent`：已实现，通知事件。
- `NotificationChannel`：已实现控制台、文件和外部 Webhook notifier；微信 channel 仍只预留。
- `NotificationSeverity`：已实现，info、watch、warning、critical。
- `NotificationDeduper`：已实现，基于 dedupeKey 和时间窗口去重。
- `NotificationCooldown`：已实现，基于 cooldownKey 冷却，critical 默认绕过普通冷却。
- `NotificationRoutePlan`：已实现，按通知级别和配置生成 console/file/webhook/wechat 路由计划。
- `NotificationTemplate`：消息模板。

## 输入

- 小脑事件。
- 风控事件。
- 研究报告。
- 系统异常。

## 输出

- 标准化通知消息。
- 是否发送。
- 发送记录。

## 验收

- 同一股票同类告警不会刷屏。
- critical 级别不会被普通冷却误吞。
- 通知内容包含时间、标的、触发规则、建议动作。

## U6 当前实现

已新增通知领域模型、格式化、去重和冷却策略：

- `NotificationEvent`：包含 `occurredAt`、`severity`、`source`、`target`、`summary`、`recommendedAction`、`auditEventId`、`correlationId` 和通知渠道。
- `NotificationSeverity`：`info`、`watch`、`warning`、`critical`。
- `NotificationChannel`：当前已实现 `console`、`file` 和 infrastructure 层 `WebhookNotifier`；`wechat` 只作为预留 channel，不接真实外部系统，设计见 `docs/architecture/decision-records/2026-06-15-wechat-notification-design.md`。
- `evaluateNotificationPolicy()`：返回 `send`、`skip_duplicate` 或 `skip_cooldown`，默认 critical 不被普通冷却压制。
- `planNotificationRoute()`：在冷却/去重策略之上生成通道计划。默认 `info` 走 `console`，`watch`/`warning`/`critical` 走 `console` + `file`；`webhook` 和 `wechat` 默认关闭，只有在 `externalChannelsEnabled` 中显式开启才会进入计划。
- `formatNotificationForConsole()`：生成控制台单行消息。

当前接口：

```ts
import {
  evaluateNotificationPolicy,
  formatNotificationForConsole,
  notificationEventSchema,
  planNotificationRoute,
} from "./src/domain/notification/index.js";

const event = notificationEventSchema.parse({
  eventId: "notification-001",
  occurredAt: "2026-06-14T02:00:00.000Z",
  severity: "warning",
  source: { type: "cerebellum", id: "market-sentinel" },
  target: { type: "symbol", symbol: "000636", market: "SZSE" },
  summary: "Paper stop-loss warning.",
  recommendedAction: "Review position manually.",
  auditEventId: "audit-001",
  channels: ["console", "file"],
});

const decision = evaluateNotificationPolicy(event);
const route = planNotificationRoute(event);
const line = formatNotificationForConsole(event);
```

通知输出会对 `apiKey`、`token`、`password`、`secret` 等字段和常见密钥文本做脱敏。领域层不联网、不写文件、不调用真实微信或 webhook；外部 Webhook 发送只在 infrastructure 层完成，并支持 mock fetch 测试。

## 路由和升级

`critical` 通知必须生成审计事件，并保持多通道路由。即使配置误把 critical 指到外部通道，路由层也会补回本地 `console` 和 `file` 作为安全降级。重复通知和同类告警冷却仍由 `evaluateNotificationPolicy()` 控制。

## 微信通知设计

R4-2 只完成微信通知 ADR 和最小接口契约，不实现真实 `WechatNotifier`。候选通道包括企业微信机器人、企业微信应用消息、微信公众号模板消息和 Server 酱类转发服务。后续实现必须默认关闭真实网络、使用 mock fetch 测试、从环境变量或本机密钥管理读取凭据引用，并继续复用通知脱敏策略。
