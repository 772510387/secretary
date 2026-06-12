# Unit Tests

单元测试优先覆盖 `src/domain`。

## 必测

- T+1。
- 100 股整数。
- 主板过滤。
- 现金不足。
- 持仓不足。
- 单股 40%。
- 8% 止损。
- 告警冷却。
- 记忆写入策略。
- 审计事件结构。

当前已覆盖：

- account schema 正反例。
- position schema 正反例和数量一致性。
- trade-record schema 正反例。
- audit-event schema 正反例和 JSON metadata。
- `data/schemas/*.schema.json` 可解析性。
- portfolio 现金、持仓、市值、成本、浮盈浮亏、T+1 可卖数量、仓位比例、成本价计算。
- PolicyEngine 主板过滤、100 股买入、T+1、现金、持仓、账户状态基础规则。
- RiskEngine 单股 40%、8% 硬止损、单日亏损限制、禁买、熔断和组合风险结果。
- MarketSentinel 单次检查，覆盖 1 分钟急涨/急跌、持仓止损、冷却状态、同标的多事件和非法配置。
- BrainProvider 抽象和 MockBrainProvider，覆盖输入默认值、工具执行权限禁止、结构化输出校验、坏输出拒绝和真实 provider 缺 key 错误。

## 要求

- 不访问网络。
- 不读写真实 memory。
- 使用 fixtures。
