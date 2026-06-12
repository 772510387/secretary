# Cerebellum Domain

小脑负责低成本、确定性、常驻的触发和调度判断。

## 需要实现

- `CerebellumEvent`：已实现，小脑事件。
- `SentinelRule`：盘中盯盘规则。
- `AlarmRule`：固定闹钟规则。
- `CooldownPolicy`：已在单次检查中实现基础冷却状态。
- `WakeBrainPolicy`：已在 T010 中先固定为触发事件即唤醒大脑。
- `SignalSeverity`：已实现，info、watch、warning、critical。

## 当前实现

T010 已实现 `MarketSentinel` 单次检查，只做纯函数判断，不做常驻进程。

- `schemas.ts`：定义 `CerebellumEvent`、`CerebellumEventType`、`SignalSeverity`。
- `market-sentinel.ts`：提供 `checkMarketSentinel(input)`。
- `index.ts`：导出小脑领域接口。

`checkMarketSentinel` 输入：

- `quotes`：当前行情快照。
- `positions`：当前持仓。
- `previousQuotes`：上一批行情快照，用于判断 1 分钟急涨急跌。
- `cooldownState`：调用方持久化或传入的冷却状态。
- `now`：本次检查时间。
- `options`：阈值配置。

`checkMarketSentinel` 输出：

- `checkedAt`：本次检查时间。
- `events`：本次产生的 `CerebellumEvent[]`。
- `nextCooldownState`：调用方下次检查应继续传入的冷却状态。

默认规则：

- 60 秒内涨跌幅绝对值达到 2% 触发 `price_surge` 或 `price_drop`，严重级别 `warning`。
- 持仓相对成本价亏损达到 8% 触发 `position_stop_loss`，严重级别 `critical`。
- 冷却键按 `eventType:market:symbol` 区分，默认冷却 10 分钟。
- 事件只表达告警和唤醒意图，不执行交易。

## 触发类型

- 盘中价格异动。
- 持仓止损风险。
- 指数快速下跌。
- 固定时间报告。
- 用户 On-Demand 查询。
- 系统异常。

## 输出

- 告警事件。
- 研究任务。
- 通知任务。
- 审计事件。

## 禁止

- 不在小脑里调用 LLM 进行每秒分析。
- 不在小脑里执行交易。
- 不把小脑规则写成 prompt。
