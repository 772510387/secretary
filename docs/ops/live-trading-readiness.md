# 实盘交易准备清单

本项目默认不做实盘交易。本文件只定义未来进入实盘前必须满足的条件。

当前状态：U10 已完成预备评估和边界设计，R9/R10 已补非交易性 gate、allowlist、kill switch、fake/read-only broker contract 和 QMT fake 协议。项目没有实现真实 broker，没有写券商账号，没有真实下单能力。

详细 ADR：

- `docs/architecture/decision-records/2026-06-15-live-trading-preparation-evaluation.md`

## 账户和接口

- 已向券商确认程序化交易权限。
- 已确认是否需要向交易所报告。
- 已确认 QMT、PTrade 或券商 API 的使用边界。
- 已确认接口支持查询现金、持仓、可卖数量、委托、成交、撤单。

## 系统能力

- `PaperBroker` 已稳定运行。
- 半自动人工确认流程已稳定运行。
- 所有真实交易路径都有审计日志。
- 所有订单有唯一 `intent_id`，可防重复提交。
- 下单前会重新拉取账户和持仓。
- 下单后会查询委托和成交回报。

实盘前仍缺少：

- 真实 broker adapter。
- 真实只读 broker smoke。
- 委托、成交、资金和持仓对账模型。
- 人工审批持久化和操作者会话。
- 单日交易次数限制。
- 总仓位限制。

已完成但仍只属于非交易性安全底座：

- `LiveTradingGate`。
- 账户 allowlist。
- 全局、账户、标的 kill switch 状态持久化。
- `LiveBrokerAdapter` contract 和 `FakeLiveBrokerAdapter`。
- `ReadOnlyBroker` fake 只读适配器。
- `QmtFakeSubprocessBridge` fake 协议测试版。

## 人工确认门禁

未来 `ManualConfirmBroker` 只作为人工确认门禁，不是真实 broker。

标准路径必须是：

```text
trade_intent_review proposal
  -> human review
  -> approved proposal
  -> deterministic TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> ManualConfirmBroker
  -> LiveBroker delegate
  -> broker order / execution query
  -> reconciliation
  -> AuditLog
```

人工确认前：

- `pending_review` 提案不可执行。
- `executable=false`。
- `brokerSubmissionAllowed=false`。
- 不得进入 paper broker 或 live broker。

人工确认后：

- `approved` 不等于下单。
- 仍然需要重新拉取账户、持仓、可卖数量和最新行情。
- 仍然需要通过 `PolicyEngine`。
- 仍然需要通过 `RiskEngine`。
- 仍然需要写下单前审计。
- 下单后仍然需要委托查询、成交查询和对账审计。

人工确认记录至少包含：

- proposalId。
- reviewer。
- decision。
- reviewedAt。
- reviewNote。
- operatorSessionId。
- 风控快照或校验结果引用。

没有完整确认记录时，系统必须拒绝进入 broker delegate。

## 风控

- `LIVE_TRADING=false` 是默认值。
- 实盘启动需要配置开关和运行态开关双重确认。
- 单日最大亏损限制已实现。
- 单股最大仓位已实现。
- 禁买和熔断机制已实现。
- LLM 不具备直接发单权限。
- 单日最大交易次数限制尚未实现，实盘前必须补齐。
- 总仓位限制尚未实现，实盘前必须补齐。

## LiveTradingGate 准入矩阵

未来任何 live broker 委托前必须先生成 `LiveTradingGateResult`，并写入审计。

| 检查项 | 当前状态 | 缺失时行为 |
| --- | --- | --- |
| `LIVE_TRADING=true` | 未开启 | 拒绝 |
| `TRADING_MODE=live` | R9 已实现 gate 输入校验 | 拒绝 |
| broker provider 明确选择真实 broker | R9 已实现 provider 类型校验，当前测试只用 `fake_live` | 拒绝 |
| 账户 allowlist 命中 | R9 已实现 schema、存储和缺失默认拒绝 | 拒绝 |
| 完整人工确认记录 | paper-only 已有最小对象 | 拒绝 |
| `PolicyEngine` 通过 | 已实现 | 拒绝 |
| `RiskEngine` 通过 | 已实现 | 拒绝 |
| 全局 kill switch 未触发 | R9 已实现 | 拒绝 |
| 账户 kill switch 未触发 | R9 已实现 | 拒绝 |
| 标的 kill switch 未触发 | R9 已实现 | 拒绝 |
| 禁买和熔断未触发 | 已实现运行态输入 | 拒绝新增买入 |
| 下单前审计写入成功 | R9 已实现 gate metadata 审计；真实下单审计仍待 live broker contract | 拒绝 |
| broker 可查询委托状态 | R10 已有 fake/read-only contract；真实 broker 未实现 | 拒绝 |
| broker 可查询成交回报 | R10 已有 fake/read-only contract；真实 broker 未实现 | 拒绝 |
| 对账可运行 | 未实现 | 拒绝 |

## LIVE_TRADING 边界

`LIVE_TRADING=true` 不足以发实盘单。

未来发起任何 live broker 委托前，至少需要同时满足：

- `LIVE_TRADING=true`。
- `TRADING_MODE=live`。
- broker provider 明确选择真实 broker。
- 当前账户在实盘允许列表中。
- 真实 broker 凭证来自环境变量或本机密钥管理，且不进入仓库。
- 当前操作员完成强制人工确认。
- 该笔订单有单独确认记录。
- `PolicyEngine` 通过。
- `RiskEngine` 通过。
- 熔断、禁买和应急停机未触发。
- 下单前审计写入成功。
- broker 返回委托后能查询订单状态。
- 成交后能完成对账。

缺少任一条件时，系统必须停在拒绝状态并写审计，不得尝试真实下单。

## QMT / PTrade 预备结论

QMT / XtQuant：

- 未来第一候选。
- 只允许通过外部 Python 子进程桥接评估；当前只实现 `QmtFakeSubprocessBridge` fake 协议测试版，不调用 MiniQMT。
- 不把 MiniQMT 客户端路径、账号、密码或 token 写入仓库。
- 不把 Python SDK 直接嵌入 TypeScript 领域层。
- 先做只读查询 smoke，再考虑小额人工委托 smoke。

PTrade：

- 未来第二候选。
- 更适合作为券商侧托管环境或独立量化平台评估。
- 不作为当前首个本地 live delegate。
- 若采用，必须先确认券商版本、运行环境、权限、回测/实盘隔离、日志导出和对账方式。

当前结论：

- 不实现真实 `QmtBroker`。
- 不实现 `PTradeBroker`。
- 不接真实 broker。

## 对账要求

未来 `Reconciliation` 至少需要覆盖：

- 本地 `intentId` 与 broker 委托编号的映射。
- 本地订单状态与 broker 委托状态。
- 本地成交记录与 broker 成交回报。
- 本地现金、冻结资金和 broker 资金。
- 本地持仓、可卖数量、冻结数量和 broker 持仓。
- 部分成交、废单、撤单中、未知状态和重复回报。

对账失败时：

- 写 `critical` 审计。
- 发送 `critical` 通知。
- 打开账户级 `cancelOnly` 或 `readOnly` 状态。
- 不自动继续下单。

## 最小人工 Smoke 顺序

实盘 smoke 必须人工、小额、单笔、限价，不允许自动买入。

1. 只读 smoke：查询账号状态、资金、持仓、委托、成交。
2. 只撤单 smoke：只在券商测试环境或明确可撤场景验证。
3. 人工小额卖出 smoke：仅限已有小额持仓，100 股，限价，双重人工确认。
4. 人工小额买入 smoke：只有在卖出 smoke、对账、审计和应急停机稳定后才评估。

每次 smoke 必须记录：

- operatorId。
- operatorSessionId。
- account allowlist 命中结果。
- proposalId。
- approvalId。
- policyResult。
- riskResult。
- liveGateResult。
- brokerRequestId。
- brokerOrderId。
- executionIds。
- reconciliationResult。
- 人工复核备注。

## 禁止方案

- 禁止用模拟点击客户端替代正式 API。
- 禁止保存明文交易密码。
- 禁止异常重试市价单。
- 禁止模型输出直接变成券商委托。
- 禁止绕过人工确认直接进入全自动买入。
- 禁止把 `approved` 提案直接当作 live broker 订单。
- 禁止用 `LIVE_TRADING=true` 覆盖人工确认、风控或审计失败。
