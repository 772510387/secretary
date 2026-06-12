# Scheduler Infrastructure

负责北京时间调度、交易日历和常驻任务运行。

## 需要实现

- `BeijingClock`：已实现，统一北京时间。
- `TradingDayScheduler`：已实现，按北京时间判断 A 股盘中时段。
- `MarketSentinelRunner`：已实现，支持盘中循环、非交易时段降频和手动单次触发。
- `AlarmJobRegistry`：已实现，固定闹钟注册和同一分钟防重复触发。
- `JobLock`：已实现，防止同一任务重复运行。
- `GracefulShutdown`：已实现，统一停止信号和 shutdown hook。

## 当前接口

- `toBeijingDateTime(date)`：把任意 `Date` 转成北京时间结构。
- `TradingDayScheduler.isMarketOpen(date)`：判断当前是否处于默认 A 股盘中时段。
- `AlarmJobRegistry.register(job)` / `runDue(now)`：注册固定北京时间闹钟并运行当前到点任务。
- `JobLock.runExclusive(jobId, task)`：同一 `jobId` 运行中时返回 `skipped_locked`。
- `MarketSentinelRunner.start()` / `triggerOnce()` / `stop()`：盘中循环、单次触发和优雅停止。
- `GracefulShutdown.register(name, hook)` / `shutdown(reason)`：集中停止常驻任务。

默认交易时段：

- 周一到周五。
- 上午 `09:30-11:30`。
- 下午 `13:00-15:00`。

说明：

- 当前不内置中国节假日交易日历，只做周末过滤和日内时段过滤。
- `MarketSentinelRunner` 默认盘中间隔 `3000ms`，非交易时段间隔 `60000ms`。
- Scheduler 只调度回调，不读取账户、不请求行情、不调用 LLM、不执行交易。

## 首批任务

- 盘中每 3 秒行情观察。
- 08:30 盘前计划。
- 09:25 集合竞价观察。
- 11:35 午间复盘。
- 14:45 尾盘检查。
- 15:30 收盘复盘。
- 20:30 新闻复核。
- 00:00 每日自省。

## 验收

- 非交易时段不做高频轮询。
- 任务重复启动时不会并发写账本。
- 系统退出时能停止循环。
- 日志落盘后续由 `logging` 模块接入。
