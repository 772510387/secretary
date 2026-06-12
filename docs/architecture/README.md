# Secretary 架构总览

## 设计目标

`secretary` 的目标是成为一个可持续演进的 A 股智能交易辅助系统。

系统要同时满足四件事：

- 盘中能长期运行。
- 交易和风控可审计。
- 大模型能力可替换。
- 未来可接真实券商，但默认不实盘。

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
- 生成交易建议草案。

AI 不可以做：

- 直接改账户。
- 直接发单。
- 直接绕过风控。
- 直接覆盖规则。
- 直接写入长期记忆的最终版本。

## 交易安全路径

```text
Brain/Research output
  -> TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> OrderManager
  -> BrokerAdapter
  -> Reconciliation
  -> AuditLog
```

任何真实资金相关动作都必须经过这条路径。

