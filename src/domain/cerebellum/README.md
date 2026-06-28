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
- 常驻哨兵可显式开启“突破前高”红线：当前价突破上一 tick 的日内前高时触发 `previous_high_breakout`，严重级别 `warning`，并受同一冷却账本约束。
- 持仓相对成本价亏损达到 8% 触发 `position_stop_loss`，严重级别 `critical`。
- 高优先级自选股日内涨跌幅达到 3% 触发 `watchlist_price_surge` 或 `watchlist_price_drop`，接近 `observePrice` 1% 内触发 `watchlist_observe_price_near`。
- 冷却键按 `eventType:market:symbol` 区分，默认冷却 10 分钟。
- 事件只表达告警和唤醒意图，并返回 metadata-only 审计事件草稿；不执行交易。

## 触发类型

- 盘中价格异动。
- 持仓止损风险。
- 高优先级自选股涨跌和接近观察价。
- 指数快速下跌、快速上涨和多指数系统性风险。
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

## R2-1 固定闹钟矩阵

已新增 `FIXED_CEREBELLUM_ALARM_RULES` 和上下文包构造。所有时间均为北京时间 `Asia/Shanghai`：

- `08:00` 数据预热，工作日。
- `08:15` 隔夜消息整理，工作日。
- `08:30` 盘前计划，工作日。
- `09:15` 集合竞价观察，工作日。
- `09:25` 开盘前确认，工作日。
- `10:30` 早盘必报回顾，工作日。
- `11:30` 午间回顾，工作日。
- `13:30` 午后跳水风险必报扫描，工作日。
- `14:30` 尾盘预案，工作日。
- `15:00` 收盘快照，工作日。
- `15:30` 盘后扩展复盘，工作日。
- `20:30` 深度复盘，工作日。
- `21:00` 次日观察池整理，工作日。
- `00:00` 每日自省，每天。
- 周六 `10:00` 周复盘。
- 月末 `20:00` 月复盘。
- `12-31 20:00` 年复盘。

每个闹钟都有稳定 `alarmId`、`jobId`、`alarmType` 和上下文包构造规则。新增的细分闹钟会映射到现有 `brainTaskType`：盘前类映射 `pre_market_plan`，盘中类映射 `midday_review`，收盘类映射 `closing_review`，复盘/自省类映射 `daily_reflection`。

当前接口：

```ts
import {
  buildCerebellumAlarmTask,
  getDueCerebellumAlarms,
} from "./src/domain/cerebellum/index.js";

const due = getDueCerebellumAlarms({ now: "2026-12-31T12:00:00.000Z" });
const task = buildCerebellumAlarmTask({
  alarm: due[0],
  scheduledAt: "2026-12-31T12:00:00.000Z",
  sources: [
    {
      sourceId: "rules-risk",
      category: "rules",
      relativePath: "memory/rules/risk.md",
      summary: "Risk rule summary only.",
    },
  ],
});
```

上下文包只保存路径、摘要和必要元数据；`apiKey`、`token`、`password`、`secret` 等元数据会被脱敏，指向 secrets 或 `.env` 的路径会被拒绝。小脑闹钟任务固定 `toolExecutionAllowed=false`、`brokerSubmissionAllowed=false`、`accountWriteAllowed=false`、`liveTradingAllowed=false`。R2-1 只生成任务对象和上下文包，不启动 daemon、不联网、不接 broker。

## R2-2 链式静默巡航

已新增 `buildSilentPatrolTask(input)` 和 `isSilentPatrolDue(now)`。默认规则按 `docs/display/daily-alarm-list.md` 的显式北京时间槽位生成 `silent_patrol` 任务：`09:30/09:35/09:40/09:45/10:00/10:10/10:20/10:40/10:50/11:00/11:10/11:20` 和 `13:00/13:10/13:20/13:40/13:50/14:00/14:10/14:20/14:40/14:50`。`10:30`、`13:30`、`14:30`、`15:00` 等必报点由固定闹钟矩阵处理，不重复作为静默巡航点。

- 不在交易时段内，或分钟不在显式巡航槽位上时，返回 `due=false` 和跳过原因。
- 在交易时段内但没有异常时，任务状态为 `silent`，`wakeBrain=false`，只保留巡航 metadata 和冷却状态。
- 出现 `MarketSentinel` 异常时，任务状态为 `pending_events`，输出待处理事件和审计 metadata，但 `brainProviderCalled=false`，不调用 LLM、不接 broker、不写账户。巡航默认使用 3% 槽位波动阈值、21 分钟窗口、±5% 绝对红线和突破前高红线，以覆盖 10:20 → 10:40 这类跳过必报点后的间隔。
- 冷却状态继续由调用方持久化并在下次传入；本领域函数只返回 `nextCooldownState`，不会直接读写文件。

## R2-3 闹钟 SOP 上下文模板

已新增 `buildCerebellumAlarmSop(alarm)`。`buildCerebellumContextPackage()` 会为每个固定闹钟自动注入确定性 SOP：

- `wakeRule`：说明本次唤醒来自北京时间固定闹钟、周/月/年复盘或每日自省规则。
- `operationInstructions`：纯动作指令列表，渲染时使用 `1. 2. 3.` 编号，不塞示例股票、价格或持仓。
- `objective`：本闹钟要完成的操作目标。
- `requiredInputs`：只列输入路径、类别、摘要和 metadata，不包含完整正文。
- `allowedActions`：只允许生成报告任务、研究任务、通知或人工提案。
- `forbiddenActions`：禁止编造股票、自选股、持仓、现金、订单、成交、新闻或外部引用。
- `safetyConstraints`：固定禁止工具执行、broker 提交、账户写入和实盘开关。

SOP 模板不塞示例股票、不制造虚假持仓，不读取 secrets、`.env`、credential 路径。输入 source 和 metadata 会继续脱敏 `apiKey`、`token`、`password`、`secret`、`account` 等敏感字段。闹钟唤醒和盘中异动唤醒都会把“唤醒规则 + 操作指令”传给大脑；模型仍无工具执行权。

## R6-2 指数系统性风险雷达

已新增 `detectIndexSystemicRisk(input)`，基于 `IndexSnapshot[]` 做确定性阈值判断：

- 支持按 `lookbackMs` 检查 1 分钟、5 分钟等窗口，也支持按 `lookbackCount` 检查最近 N 次快照。
- 单指数命中时生成 `index_rapid_drop` 或 `index_rapid_surge` 类型的 `MarketAnomaly`。
- 多指数同时跌破 `systemicRiskThreshold` 时生成 `systemic_risk`。
- 命中后只生成 `MarketAnomaly` 和 `NotificationEvent` 草稿，通知默认 `console/file`，metadata 固定 `brokerConnected=false`、`brainProviderCalled=false`、`directExecutionAllowed=false`、`liveTrading=false`。
- 不调用 BrainProvider、不联网、不接 broker、不写账户、不生成订单。
