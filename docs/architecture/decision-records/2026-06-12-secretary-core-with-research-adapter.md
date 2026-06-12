# Secretary 自研核心与研究适配器

## 背景

OpenClaw 原型已经验证了“眼脑分离、盘中哨兵、小脑闹钟、文件夹记忆”的可行性。TradingAgents-CN 提供了成熟的多智能体研究流程、LLM provider 和数据工具，但其主系统较重，且 `app/`、`frontend/` 存在专有许可限制。

## 决策

`secretary` 采用自研核心底座。

TradingAgents-CN 不作为主工程，只作为可选深度研究适配器：

- 可以学习其 LangGraph 研究流程。
- 可以参考其 provider 抽象。
- 可以包装开源核心能力作为研究工具。
- 不复制专有 `app/`、`frontend/`。
- 不允许其输出直接进入交易执行。

## 影响

优点：

- 系统边界符合当前需求。
- 交易和风控可审计。
- 未来实盘接入更容易隔离风险。

代价：

- 前期需要自己实现账户、风控、记忆、调度和测试。
- TradingAgents-CN 的数据工具需要逐步适配，而不是直接搬运。

## 后续动作

- 先实现 `PaperBroker` 和完整模拟盘闭环。
- 再实现 `DeepResearchAdapter`。
- 最后评估是否接 QMT/PTrade 等真实券商接口。

