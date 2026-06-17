# 小额人工实盘 Smoke 条件评估

## 背景

R13-3 要求评估小额人工实盘 smoke 条件，不实现真实 broker，不写账号，不下单。

评估日期：2026-06-16。

## 结论

当前结论是 no-go。

项目仍不能执行任何小额实盘 smoke，也不能执行人工买入或卖出。原因是还缺真实只读 broker smoke、真实 broker adapter、真实环境授权验证和完整对账闭环。

## 条件检查

| 条件 | 当前状态 | 结论 |
| --- | --- | --- |
| LiveTradingGate | 已完成非交易性准入矩阵 | 满足基础条件 |
| 账户 allowlist | 已完成 schema 和 storage | 满足基础条件，但不能写真实账号 |
| 人工审批持久化 | R12 已推进 ApprovalRecord 存储和入口 | 仅满足本地持久化 |
| read-only broker smoke | 只有设计文档 | 未满足 |
| 对账 | R11 已推进 fake/read-only 对账 | 未完成真实对账 |
| 应急停机 | 已完成 kill switch | 满足基础条件 |
| 真实 broker ADR 和 contract test | 只有 fake/read-only contract，真实 broker 未实现 | 未满足 |
| 用户外部环境和授权 | 未提供 | 未满足 |

## 禁止事项

当前仍禁止：

- 自动买入。
- 自动卖出。
- LLM 输出直接成为订单。
- 只靠 `LIVE_TRADING=true` 发单。
- 保存明文交易密码。
- 使用模拟点击客户端。
- 在没有真实只读 smoke 和对账前执行小额委托。

## 未来最小条件

未来重新评估前必须完成：

- 真实只读 broker adapter。
- 只读 smoke 设计中列出的 allowlist、kill switch、审计和失败降级。
- 真实账户只读查询 smoke。
- 对账模型和真实只读查询结果对账。
- 人工审批持久化和操作者会话。
- 单日交易次数限制。
- 总仓位限制。
- 真实 broker 下单/撤单 ADR。
- 用户明确提供外部环境和授权。

## 当前可做事项

当前只能继续做：

- fake live rehearsal。
- fake/read-only 对账。
- ApprovalRecord 本地持久化。
- 对账失败 readOnly/cancelOnly 降级。
- 只读 smoke 文档和检查脚本设计。

不得接真实 broker，不得写账号，不得下单。
