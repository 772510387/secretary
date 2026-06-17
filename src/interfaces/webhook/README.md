# Webhook Interface

负责外部事件入口，例如聊天机器人、告警系统或本机自动化。

## 需要实现

- `POST /webhook/user-message`：用户自然语言请求。R3-1 已实现请求 schema 和安全计划生成，尚未启动真实 HTTP server。
- `POST /webhook/market-event`：行情异动事件。R3-1 已实现 schema，可生成通知计划。
- `POST /webhook/manual-confirm`：人工确认交易。R3-1 只生成 `manual_confirm_review_task`，不触发 broker handoff。
- `POST /webhook/system-event`：系统级事件。R3-1 已实现 schema，可生成系统通知计划。

## 处理要求

- `handleWebhookRequest(input, options)` 会校验最小 bearer token；未配置 token 或 token 不匹配都会拒绝。
- 请求必须通过 `webhookRequestSchema`，支持 `user_message`、`market_event`、`manual_confirm`、`system_event`。
- 内置内存态 `WebhookSecurityState` 用于 requestId 幂等去重和最小限流；调用方负责持久化或继续传入状态。
- Webhook 只返回 `plannedActions`、`toolPlans`、`auditEvent`、`accessAudit` 和下一份 security state，不直接执行任务。
- Webhook 同时返回 `accessAudit` 摘要，显式记录 `auditId`、`requestId`、`source`、`eventType`、`result`、重复请求标记、限流标记和拒绝原因。
- 重放 requestId 会返回 `skipped_duplicate`；限流失败会返回 `rate_limited`，并在审计 metadata 中包含 `errorCode=rate_limited`、`rateLimitKey` 和 `retryAfterMs`。
- 工具请求会交给 `ToolRuntime` 生成非执行计划；`execute_order`、`write_account`、`read_secret`、`enable_live_trading` 等非法工具会被拒绝。
- 审计只记录 requestId、eventType、来源、计数、拒绝原因和安全开关；不会记录 token、secret header 或完整用户消息。

## 禁止

- 不允许 webhook 直接下单。
- 不允许 webhook 直接改账户 JSON。
- 不允许 webhook 读取密钥或 `.env`。
- 不允许 webhook 直接调用 BrainProvider、broker、文件系统或外部网络。

当前接口示例：

```ts
import { handleWebhookRequest } from "./src/interfaces/webhook/index.js";

const result = handleWebhookRequest(request, {
  expectedToken: process.env.SECRETARY_WEBHOOK_TOKEN,
  securityState,
});

// 调用方只消费 result.plannedActions / result.toolPlans，
// 不得把 webhook 结果直接转成 broker 请求。
```
