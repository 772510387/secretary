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
- MarketSentinel 单次检查，覆盖 1 分钟急涨/急跌、±5% 日内红线、突破前高、持仓止损、冷却状态、同标的多事件和非法配置。
- Cerebellum 链式静默巡航，覆盖 daily-alarm-list 显式槽位、非交易时段跳过、无异常静默、异常事件、冷却去重和 metadata 脱敏。
- Cerebellum 闹钟 SOP 上下文模板，覆盖每个固定闹钟的 objective、requiredInputs、allowedActions、forbiddenActions 和安全约束。
- Market history indicators，覆盖 MA5、MA10、MA20、60 日区间位置、趋势标签、样本不足和空输入。
- MemoryWritePolicy，覆盖自动允许、软阈值受限允许、硬规则提案和危险写入拒绝。
- LiveTradingGate、LiveAccountAllowlist 和 KillSwitchState，覆盖 `LIVE_TRADING=true` 不足以通过、缺 allowlist 默认拒绝、账户脱敏、通配拒绝、Policy/Risk 必须通过和全局/账户/标的三级应急停机。
- BrainProvider 抽象和 MockBrainProvider，覆盖输入默认值、工具执行权限禁止、结构化输出校验、坏输出拒绝和真实 provider 缺 key 错误。
- DashScopeQwenProvider，覆盖 mock fetch、缺 key、401/403、429、5xx、超时、空响应、坏 JSON、坏 schema、本地 Zod 校验和工具执行权限拒绝。
- OpenAIProvider，覆盖官方 Chat Completions JSON Mode 请求形状、mock fetch、缺 key、401/403、429、5xx、超时、空响应、坏 HTTP JSON、坏 message JSON、坏 schema、本地 Zod 校验、工具执行权限拒绝和 provider 身份校验。
- `research:once` 开发脚本参数解析，覆盖必填参数、别名、help、非法 market/symbol/date、未知参数和缺值错误。
- TradeIntentReviewProposal 转换，覆盖研究草案到 `pending_review` 人工确认提案、默认不可执行和待审状态约束。
- Cerebellum 全天固定北京时间闹钟矩阵，覆盖 08:00 到 21:00、00:00、周六、月末、闰年月末、年末、稳定 id 和上下文包脱敏。
- Notification 领域模型和策略，覆盖事件 schema、console 格式化、去重、冷却、critical 绕过普通冷却、按级别路由、外部通道默认关闭和 critical 审计事件生成。
- Runtime health schema 和 metadata 脱敏，覆盖敏感 key、账号字段、长文本截断和错误摘要。
- Webhook 安全入口，覆盖请求 schema、token 鉴权、requestId 幂等去重、限流、非法工具拒绝、交易提案只进人工 review、`accessAudit` 摘要和审计 metadata 脱敏。
- 随时看盘 use case，覆盖指定股票快照、多标的盘面摘要、默认 mock provider、失败降级、非执行报告草稿和 metadata 脱敏。
- Watchlist 领域模型，覆盖三类自选池、人工 seed/import 归一化、市场推断、去重和 high priority 筛选。
- MarketSentinel 自选股扫描，覆盖 high priority 涨跌、接近观察价、冷却和 metadata-only 审计草稿。
- Index risk radar，覆盖 1 分钟窗口、最近 N 次窗口、多指数系统性风险、通知草稿和非法阈值。
- Volume price radar，覆盖量价齐升、爆量滞涨、停牌/无量、缺字段、低流动性和非法参数。
- Strategy knowledge，覆盖命名策略归因、strategy_id 派生统计、案例/决策引用渲染，以及 agent 只读工具暴露。
- Problem feedback fact pack，覆盖问责类反馈所需的 100 池覆盖证据、计划/提案/成交区分和 agent 工具只读返回。
- Operation review context，覆盖操作复盘追问所需的成交/订单/提案/计划/报告/审计拼接、北京时间转换、账户快照和数据缺口提示，以及 agent 工具只读返回。

## 要求

- 不访问网络。
- 不读写真实 memory。
- 使用 fixtures。
