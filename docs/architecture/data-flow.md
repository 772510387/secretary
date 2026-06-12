# 数据流设计

## 盘中哨兵流

```text
Scheduler
  -> QuoteProvider
  -> MarketSnapshot
  -> CerebellumSignalDetector
  -> RiskEngine
  -> NotificationPolicy
  -> Brain only when needed
  -> Memory/Audit
```

要求：

- 行情轮询不能每次调用 LLM。
- 小脑只在规则命中、用户查询或固定闹钟时唤醒大脑。
- 同一股票同类告警必须有冷却窗口。
- 所有触发条件必须可回放。

## 固定闹钟流

```text
BeijingTimeScheduler
  -> TaskPlan
  -> ContextLoader
  -> Brain/Research
  -> ReportWriter
  -> Notification
  -> AuditLog
```

首批建议任务：

- 08:30 盘前计划。
- 09:25 集合竞价观察。
- 11:35 午间复盘。
- 14:45 尾盘检查。
- 15:30 收盘复盘。
- 20:30 新闻和公告复核。
- 00:00 每日自省。

## On-Demand 查询流

```text
UserInput
  -> IntentParser
  -> ToolPlan
  -> DataRead
  -> BrainResponse
  -> OptionalMemoryProposal
```

要求：

- 查询默认只读。
- 写入必须生成提案。
- 涉及交易必须生成 `TradeIntent`，不能直接执行。

## 未来实盘流

```text
TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> ManualConfirm or AutoPolicy
  -> BrokerAdapter
  -> OrderStatus
  -> Reconciliation
  -> AuditLog
```

实盘默认关闭，必须由配置和运行态双重开启。

