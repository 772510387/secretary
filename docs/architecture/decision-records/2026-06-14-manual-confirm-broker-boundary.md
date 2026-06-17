# ManualConfirmBroker 人工确认边界

## 背景

P4-1 已把 `ResearchReport.tradeIntentDrafts` 转成 `trade_intent_review` 提案。提案默认 `pending_review`、`executable=false`，只表示“值得人工看一眼”，不是订单，也不是可直接提交给 broker 的 `TradeIntent`。

下一步需要为 T015 的 `ManualConfirmBroker` 先明确设计边界，避免后续把“人工点了批准”误解为“可以绕过策略、风控和审计直接发单”。

## 决策

`ManualConfirmBroker` 设计为人工确认门禁，不设计为真实券商实现。

它只允许处理已经人工确认的提案，并且仍然必须经过确定性交易链路：

```text
ResearchReport.tradeIntentDraft
  -> TradeIntentReviewProposal(status=pending_review, executable=false)
  -> human review decision
  -> approved proposal
  -> deterministic TradeIntent creation
  -> PolicyEngine
  -> RiskEngine
  -> OrderManager / idempotency
  -> ManualConfirmBroker handoff
  -> PaperBroker or future LiveBroker delegate
  -> AuditLog
  -> reconciliation
```

人工确认不是执行动作。`approved` 只表示“允许进入下一轮确定性校验”，不表示“允许直接下单”。

## 状态模型

P4-1 提案状态继续沿用：

- `pending_review`：默认状态，等待人工查看；不可执行。
- `approved`：人工批准进入交易前校验；仍不可直接下单。
- `rejected`：人工拒绝；不得进入订单链路。
- `applied`：后续流程完成应用；必须关联订单、拒单或跳过原因的审计记录。

未来 T015 可补充一个单独的确认记录，例如：

- `reviewId`
- `proposalId`
- `reviewer`
- `decision`
- `reviewedAt`
- `reviewNote`
- `operatorSessionId`
- `riskSnapshotId`

确认记录必须可审计，不能只依赖 UI 状态。

## ManualConfirmBroker 职责

允许：

- 校验提案状态是否为 `approved`。
- 校验人工确认记录是否完整。
- 读取或接收最新账户、持仓、行情和风控上下文。
- 调用确定性 `PolicyEngine` 和 `RiskEngine`。
- 在校验通过后，把订单请求交给下游 delegate broker。
- 记录人工确认、校验、提交、拒绝、成交回报和对账审计。

禁止：

- 直接消费 `ResearchReport` 或 LLM 输出。
- 直接消费 `pending_review` 提案。
- 绕过 `PolicyEngine` 或 `RiskEngine`。
- 自己修改账户、持仓或交易流水。
- 保存券商密码或真实交易密钥。
- 在无人工确认记录时调用 `PaperBroker` 或未来 live broker。

## Paper 与 Live 的进入方式

模拟盘：

```text
approved proposal
  -> deterministic TradeIntent
  -> PolicyEngine + RiskEngine
  -> ManualConfirmBroker
  -> PaperBroker delegate
```

模拟盘 delegate 可以是当前 `PaperBroker`，但也必须保留 `intentId` 防重复和审计链路。人工确认不能跳过现有 `PaperBroker` 的账户、持仓、订单和审计写入规则。

未来实盘：

```text
approved proposal
  -> deterministic TradeIntent
  -> fresh account/position/query
  -> PolicyEngine + RiskEngine
  -> manual final confirmation
  -> ManualConfirmBroker
  -> LiveBroker delegate
  -> broker order query
  -> execution reconciliation
  -> AuditLog
```

实盘 delegate 只能在额外实盘准备条件满足后接入。`ManualConfirmBroker` 本身不等于 live broker。

## LIVE_TRADING 边界

`LIVE_TRADING=true` 不足以发实盘单。

未来进入 live delegate 至少需要同时满足：

- `LIVE_TRADING=true`。
- `TRADING_MODE=live`。
- broker provider 显式选择真实 broker，例如 QMT/PTrade。
- 账户在允许列表中。
- 真实 broker 凭证来自本机密钥管理或环境变量，不进入仓库。
- 当前进程持有人工确认会话。
- 每一笔订单都有单独人工确认记录。
- `PolicyEngine` 通过。
- `RiskEngine` 通过。
- 下单前重新查询账户、持仓和可卖数量。
- 下单前写入审计。
- 下单后拉取委托、成交并对账。
- 应急停机和熔断开关处于正常状态。

缺少任一条件时，系统必须拒绝进入 live delegate。

## 审计要求

至少记录这些事件：

- 提案写入：`trade_intent_review` 来源、状态和执行保护标记。
- 人工确认：reviewer、decision、reviewedAt、reviewNote。
- 策略校验：PolicyEngine 输入摘要和结果。
- 风控校验：RiskEngine 输入摘要和结果。
- broker handoff：目标 delegate、intentId、proposalId。
- broker 结果：订单状态、拒绝原因、成交回报。
- 对账结果：订单、成交、账户和持仓是否一致。

审计日志不得记录完整研究正文、模型长推理、交易密码、真实 broker token 或明文账户敏感信息。

## 替代方案

方案一：人工批准后直接调用 `PaperBroker`。

拒绝。这样会把人工确认和交易执行耦合，后续容易把同一入口迁移到 live broker，风险过高。

方案二：把 `ManualConfirmBroker` 做成真实 broker。

拒绝。人工确认是门禁，真实券商适配必须仍然在单独的 `BrokerAdapter` 中实现。

方案三：只在 UI 层做人工确认。

拒绝。UI 状态不可作为唯一安全边界，确认记录、策略校验、风控校验和审计必须由后端确定性代码落地。

## 后续动作

- T015 实现 `ManualConfirmBroker` 前，先实现确认记录 schema 和状态流转测试。
- 明确 `approved proposal -> TradeIntent` 的确定性转换规则。
- 为 paper delegate 写集成测试，验证批准后仍经过 PolicyEngine、RiskEngine 和 AuditLog。
- 实盘 delegate 只在 live readiness 全部满足后评估。
