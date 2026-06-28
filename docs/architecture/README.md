# Secretary 架构总览

## 设计目标

`secretary` 的目标是成为一个可持续演进的 A 股智能交易辅助系统。

系统要同时满足四件事：

- 盘中能长期运行。
- 交易和风控可审计。
- 大模型能力可替换。
- 可接模拟盘、只读 broker、fake live broker 和真实券商，运行模式由配置和权限决定。

## 当前工程化基线

截至 2026-06-15，T001-T014 和 U1-U9 已完成，U10 已完成实盘预备评估。

当前系统具备可测试的模拟盘、风控、审计、行情、历史 K 线、记忆写入策略、记忆检索、工具请求校验、固定闹钟上下文包、本地通知、DashScope Qwen provider、OpenAIProvider、TradingAgents-CN fake subprocess runner、ManualConfirmBroker，以及 LiveTradingGate、账户 allowlist 和 kill switch。

当前实盘接入仍在演进阶段：

- 真实 broker adapter 待接入。
- LiveTradingGate、账户 allowlist 和 kill switch 已作为实盘接入前置能力。
- 实盘对账系统待完善。
- 常驻 daemon 和运行态观测仍需继续压实。
- 自动化执行能力按“模型提案 -> 风控/权限 -> 适配器 -> 回执/对账/审计”路径演进。

## 分层架构

```text
interfaces
  CLI / API / Webhook / future UI

runtime
  application boot, dependency wiring, lifecycle

app
  use cases, orchestration, command handlers

domain
  market / portfolio / trading / risk / memory / cerebellum / brain / research / notification / audit

infrastructure
  storage / provider SDK / broker SDK / scheduler / logging

data + memory + config
  schemas, seeds, runtime memory, non-secret configuration
```

## 责任划分

`domain` 是系统可信核心，不直接依赖外部世界。

`infrastructure` 负责把外部世界适配成领域层需要的接口，包括行情、模型、券商、文件系统、数据库、调度器和通知渠道。

`app` 负责组织一个完整用例，例如“盘中哨兵发现异动后生成研究请求并写入报告”。

`interfaces` 负责接收用户或外部系统请求，例如命令行、HTTP API、Webhook。

`runtime` 是组合根，只做启动、依赖注入、任务注册和关闭。

## AI 使用边界

AI 可以做：

- 新闻和政策解释。
- 题材和逻辑归因。
- 多空观点整理。
- 复盘和反思。
- 生成标的排序、交易意图、执行提案、仓位思路和交易建议。

账户、规则和执行层要求：

- 账户和订单状态以执行适配器、broker 回执、账本和审计事件为准。
- 风控、仓位、T+1、100 股整数、涨跌停等确定性约束保留代码实现。
- 规则和长期记忆的最终版本需要显式工具、审批或审计记录承接。

## 交易安全路径

```text
Brain/Research output
  -> TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> LiveTradingGate
  -> OrderManager
  -> BrokerAdapter
  -> Reconciliation
  -> AuditLog
```

任何资金相关动作都必须留下可追溯的意图、检查、执行、回执、对账和审计记录。
