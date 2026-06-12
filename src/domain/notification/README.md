# Notification Domain

负责告警、通知内容、冷却和去重策略。

## 需要实现

- `NotificationEvent`：通知事件。
- `NotificationChannel`：控制台、文件、Webhook、未来微信/邮件。
- `NotificationSeverity`：info、watch、warning、critical。
- `NotificationDeduper`：去重。
- `NotificationCooldown`：冷却。
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

