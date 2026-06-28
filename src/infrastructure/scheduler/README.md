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
- `AlarmJob.shouldRun(beijingTime)`：可选条件谓词，用于周复盘、月末复盘、年末复盘等非每日闹钟过滤。
- `JobLock.runExclusive(jobId, task)`：同一 `jobId` 运行中时返回 `skipped_locked`。
- `MarketSentinelRunner.start()` / `triggerOnce()` / `stop()`：盘中循环、单次触发和优雅停止。
- `GracefulShutdown.register(name, hook)` / `shutdown(reason)`：集中停止常驻任务。
- Runtime 层的 `MarketSentinelDaemon` 会复用 `MarketSentinelRunner.start()` / `stop()`，并把启动、停止、重复启动和任务失败写入 scheduler 审计 metadata。

默认交易时段：

- 周一到周五。
- 上午 `09:30-11:30`。
- 下午 `13:00-15:00`。

说明：

- 当前不内置中国节假日交易日历，只做周末过滤和日内时段过滤。
- `MarketSentinelRunner` 默认盘中间隔 `3000ms`，非交易时段间隔 `60000ms`。
- Scheduler 只调度回调，不读取账户、不请求行情、不调用 LLM、不执行交易。
- R1-1 开发脚本默认注入 mock task。只有上层显式注入 provider 后，回调才会读取行情或生成研究。
- R2-2 的链式静默巡航由 `domain/cerebellum` 按 daily-alarm-list 显式槽位生成确定性任务对象；scheduler 只负责按时间触发上层回调，不直接唤醒 BrainProvider、不连接 broker。

## 首批任务

- 盘中每 3 秒行情观察。
- 盘中链式静默巡航，默认按 `09:30/09:35/09:40/09:45/10:00/10:10/10:20/10:40/10:50/11:00/11:10/11:20` 与 `13:00/13:10/13:20/13:40/13:50/14:00/14:10/14:20/14:40/14:50` 生成任务。
- 08:30 盘前计划。
- 09:25 集合竞价观察。
- 10:30 早盘必报回顾。
- 11:30 午间复盘。
- 13:30 午后跳水风险必报。
- 14:30 尾盘检查。
- 15:30 收盘复盘。
- 20:30 新闻复核。
- 00:00 每日自省。

## 验收

- 非交易时段不做高频轮询。
- 任务重复启动时不会并发写账本。
- 系统退出时能停止循环。
- 日志落盘后续由 `logging` 模块接入。
