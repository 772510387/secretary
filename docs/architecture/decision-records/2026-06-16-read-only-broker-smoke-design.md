# 只读 Broker Smoke 设计

## 背景

R9 已完成 `LiveTradingGate`、账户 allowlist 和 kill switch。
R10 已完成 fake/read-only broker contract 和 QMT fake 协议。
R11/R12 继续补对账和人工审批持久化。

本设计只描述未来读取真实账户状态的 smoke。当前不实现真实 broker，不写券商账号，不下单，不撤单，不改账户。

## 决策

未来只读 smoke 必须使用单独命令和单独配置开关，且只允许查询：

- 账户状态。
- 可用资金和冻结资金。
- 持仓、可卖数量和冻结数量。
- 当日委托。
- 当日成交。
- broker 健康状态。

只读 smoke 不允许：

- `submitOrder`。
- `cancelOrder`。
- 写账户。
- 修改持仓。
- 自动审批。
- 调用 LLM。
- 调用 TradingAgents-CN。

## 前置条件

运行前必须同时满足：

- 用户明确批准执行只读 smoke。
- `LIVE_TRADING=true` 只能作为进入检查的一个条件，不代表可交易。
- `TRADING_MODE=live_read_only` 或等价只读模式。
- broker provider 显式选择，例如 `qmt_read_only`。
- 账户存在于本地 allowlist。
- kill switch 不处于 `disabled`。
- 审计日志可写。
- broker 凭证只来自环境变量或本机密钥管理。
- 不在命令行参数、配置文件或仓库中写真实账号、密码、token。

## 环境变量边界

未来候选变量只允许本机注入：

- `SECRETARY_LIVE_READONLY_SMOKE=1`：显式启用只读 smoke。
- `SECRETARY_BROKER_PROVIDER=qmt_read_only`：选择只读 provider。
- `SECRETARY_BROKER_ACCOUNT_REF`：本机账户引用，不进入仓库。
- `SECRETARY_BROKER_CREDENTIAL_REF`：本机密钥引用，不进入仓库。

不得记录这些值的明文。审计只记录 token 是否存在、tokenId 或 credentialRef 的脱敏摘要。

## 审计字段

每次只读 smoke 至少记录：

- `requestId`。
- `operatorId`。
- `operatorSessionId`。
- `brokerProvider`。
- `maskedAccountId`。
- allowlist 命中结果。
- kill switch 解析结果。
- 查询动作列表。
- 每类查询的 recordCount。
- brokerConnected。
- `submitOrderAvailable=false`。
- `cancelOrderAvailable=false`。
- `orderSubmitted=false`。
- 对账结果引用。

审计不得记录：

- 明文账号。
- 密码。
- token。
- cookie。
- secret header。
- 完整账户正文。

## 失败降级

只读 smoke 任一查询失败时：

- 写 `warning` 或 `critical` 审计。
- 生成通知事件。
- 如果返回字段无法对账，进入账户级 `readOnly` kill switch。
- 不自动重试下单。
- 不自动转入撤单或交易流程。

对账失败时：

- 写 `critical` 审计。
- 生成 `critical` 通知。
- 打开账户级 `readOnly` 或 `cancelOnly`。
- 需要人工解除。

## 人工步骤

建议操作顺序：

1. 人工确认只读 smoke 时间窗口和账户引用。
2. 检查 allowlist、kill switch、审计可写。
3. 执行只读查询。
4. 运行对账。
5. 人工查看审计、通知和对账摘要。
6. 如异常，保持 readOnly/cancelOnly，人工处理。

## 当前结论

当前只完成设计，不实现真实只读 broker，不调用 QMT/PTrade/MiniQMT，不写账号，不联网，不下单。
