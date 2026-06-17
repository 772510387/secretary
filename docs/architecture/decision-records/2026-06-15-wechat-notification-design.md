# 微信通知通道设计

## 背景

R4-1 已实现 `WebhookNotifier`，可以通过注入 fetch 发送脱敏后的 `NotificationEvent`。R4-2 不接真实微信，不写 token，只先明确微信类通知通道的候选方案、鉴权边界、消息频率、失败降级、脱敏和测试策略，避免后续把外部通知误接成交易执行入口。

通知通道只用于把系统事件告知人，不能触发 broker、账户写入、规则覆盖或 LLM 工具执行。

## 候选方案

### 企业微信机器人

定位：第一阶段优先候选，适合内部群告警、运维提醒和盘中风险提示。

边界：

- 只发送文本或 markdown 摘要，不发送完整研究正文、账户明细或密钥。
- 鉴权材料只允许来自环境变量或本机密钥管理，不写入仓库、README 示例或测试 fixture。
- 群机器人适合通知，不适合承载人工审批。人工审批仍应走独立 proposal/approval 流程。
- 群消息可能被多人看到，默认只允许 `watch`、`warning`、`critical` 的短摘要。

### 企业微信应用消息

定位：后续增强候选，适合定向发给操作者或值班人。

边界：

- 需要更完整的企业应用配置、接收人 allowlist 和操作审计。
- 第一阶段不实现主动拉取成员、通讯录或审批状态。
- 不把应用消息回调当作 broker handoff；回调也只能生成任务或人工审批记录。

### 微信公众号模板消息

定位：不作为第一阶段实现目标，只保留调研选项。

边界：

- 用户绑定、模板审核和消息类目约束较强，不适合作为开发阶段主通知通道。
- 不用于发送交易建议细节、账户信息或完整复盘正文。
- 如果未来接入，必须先形成单独 ADR，并验证合规、频率和用户授权边界。

### Server 酱类转发服务

定位：个人开发和本机告警候选，适合作为非关键路径的低成本通知。

边界：

- 第三方转发服务不承载敏感内容。
- 不发送账户、订单、持仓明细、密钥、完整研究正文或人工审批链接中的敏感参数。
- 服务不稳定或限流时只降级为本地 file/console，不影响系统风控和审计。

## 决策

第一阶段只定义最小接口，不实现真实微信发送器。后续如实现，优先顺序为：

1. 企业微信机器人：最小可用的群通知。
2. Server 酱类服务：仅用于个人开发环境，默认关闭。
3. 企业微信应用消息：需要操作者 allowlist 后再评估。
4. 微信公众号模板消息：暂缓。

最小接口设计如下，仅作为后续实现契约：

```ts
type WechatProviderKind =
  | "wecom_bot"
  | "wecom_app"
  | "server_chan"
  | "official_account";

interface WechatNotifierOptions {
  provider: WechatProviderKind;
  endpoint?: string;
  credentialRef: string;
  recipientAllowlist?: string[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  dryRun?: boolean;
}

interface WechatDeliveryPolicy {
  minSeverity: "watch" | "warning" | "critical";
  perTargetCooldownMs: number;
  perProviderMaxPerMinute: number;
  criticalBypassesNormalCooldown: boolean;
}

interface WechatNotifier {
  readonly channel: "wechat";
  notify(event: NotificationEvent): Promise<NotificationDeliveryResult>;
}
```

`credentialRef` 只能是环境变量名、本机密钥管理引用或运行时注入引用，不能是密钥值。接口不得接受 `token`、`secret`、`corpSecret` 等明文字段。

## 消息级别

默认路由建议：

- `info`：不发微信，只允许 console/file。
- `watch`：仅在人工开启 watch 通道时发送，默认每个 target 有较长冷却。
- `warning`：可发送微信摘要，受去重和冷却约束。
- `critical`：可绕过普通冷却，但仍受全局限流和重复 requestId/notificationId 约束。

微信消息内容只包含：

- 事件时间。
- 严重级别。
- 来源类型和来源 ID。
- 标的摘要，例如 `SZSE:000636` 或 `system`。
- 一句话摘要。
- 建议动作摘要。
- 关联 `auditEventId` 或 `correlationId`。

微信消息禁止包含：

- API key、token、cookie、签名、webhook secret。
- 券商账号、交易密码、真实账户详情。
- 完整研究正文、完整用户消息、完整审计正文。
- 可直接触发交易的链接或命令。

## 鉴权边界

后续实现必须满足：

- 密钥只来自环境变量、本机密钥管理或运行时注入，不能进入 Git。
- 配置文件只能保存 `credentialRef` 和非敏感 provider 类型。
- 发送前必须校验 `provider`、`endpoint`、`credentialRef`、`recipientAllowlist`。
- 输出、错误、审计 metadata 不记录密钥值、签名串、完整 header 或完整响应正文。
- 所有外部返回都必须先脱敏再进入 `NotificationDeliveryResult.error` 或审计 metadata。

## 限流和频率

后续实现至少需要三层限制：

- 去重：同一 `eventId` 或 dedupeKey 不重复发送。
- 冷却：同一 target、source 和 severity 在冷却窗口内不刷屏。
- provider 限流：每 provider 每分钟最大发送数，429 时记录 `retryAfterMs` 并降级。

建议默认值：

- `watch`：同一 target 30 分钟内最多 1 条。
- `warning`：同一 target 10 分钟内最多 1 条。
- `critical`：同一 target 2 分钟内最多 1 条，同时受全局 provider 限流。
- provider 全局：每分钟最多 20 条，后续根据真实服务约束调整。

## 失败降级

微信发送失败不得阻塞风控、审计、报告生成或人工提案流程。

失败处理顺序：

1. 返回 `NotificationDeliveryResult.status="failed"`，错误文本脱敏。
2. 写入本地 file notifier 或 runtime 日志的摘要。
3. 429、超时、5xx 进入冷却或短期熔断，避免持续打外部通道。
4. 401/403 视为配置或凭据错误，进入 provider disabled 状态，等待人工修复。
5. critical 失败时可追加 console/file，并生成后续人工检查任务。

禁止在失败后自动扩大内容范围或改走未授权通道。

## 脱敏策略

发送前使用 `redactNotificationEvent()` 生成消息材料。后续微信 notifier 还必须额外处理：

- header、query、body 中的 token、secret、signature、credential、cookie。
- URL query 参数中的敏感值。
- 外部错误响应中的密钥片段。
- 账号、订单号、完整持仓明细等运行态敏感内容。

脱敏后的消息可以保留非敏感定位信息，例如 `eventId`、`auditEventId`、`symbol`、`market`、`severity`。

## 测试策略

默认测试：

- 使用 mock fetch，不联网。
- 覆盖成功发送、超时、401/403、429、5xx、坏 JSON、空响应和 provider 返回失败。
- 验证请求 body 和 delivery result 不含 token、secret、完整用户正文或完整研究正文。
- 验证 watch/warning/critical 的频率策略。
- 验证 critical 可绕过普通冷却但不能绕过 provider 全局限流。

真实 smoke：

- 默认跳过。
- 必须显式设置 `WECHAT_NOTIFIER_NETWORK=1`。
- 必须通过本机环境或密钥管理提供凭据引用。
- smoke 只发送固定测试摘要，不发送账户、标的建议、研究正文或真实用户内容。

## 影响

- R4-2 不新增真实外部调用，不新增依赖，不写 token。
- `wechat` 继续保留为 `NotificationChannel`，但没有真实 sender。
- 后续 R4-3 通知路由可以把微信作为默认关闭的可选外部通道。
- 如果未来实现 `WechatNotifier`，必须先按本 ADR 补 mock 测试和脱敏测试。

## 替代方案

- 直接复用 `WebhookNotifier` 发送到企业微信机器人：实现简单，但需要明确微信特有频率、鉴权和响应边界，不能直接把任意 webhook 当微信通道。
- 先做公众号模板消息：用户授权和模板约束更复杂，不适合当前阶段。
- 暂不设计微信：会让后续 R4-3 路由缺少外部人类提醒的边界。

## 后续动作

- R4-3 设计通知路由时，把微信列为默认关闭的候选通道。
- 未来实现前，先补 `WechatNotifier` mock 测试和配置 schema。
- 未来真实 smoke 必须由用户明确提供本机环境和授权，且不得进入默认 CI。
