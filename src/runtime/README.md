# Runtime

`runtime` 是组合根，负责把配置、领域服务、基础设施和入口装配起来。

## 需要实现

- `bootstrap()`：加载配置和依赖。
- `createContainer()`：装配 provider、store、broker、scheduler。
- `start()`：启动入口和定时任务。
- `shutdown()`：优雅关闭。
- `healthcheck()`：系统健康检查。

## 当前实现

- `createSchedulerRuntime()`：已实现最小 scheduler 组合根。
- `createMarketSentinelDaemon()`：已实现 MarketSentinel 开发态 daemon 入口。

当前会装配：

- `BeijingClock`
- `JobLock`
- `AlarmJobRegistry`
- `GracefulShutdown`
- `createMarketSentinelRunner()`
- `MarketSentinelRunner.triggerOnce()` 可用于测试和开发态验证一次 mock 闭环回调。
- `MarketSentinelDaemon.start()` / `stop()` 可用于开发态启动和停止本地 mock 哨兵循环，并写入 scheduler 审计 metadata。
- `MarketSentinelDaemon.health()` 可读取 `memory/logs/runtime-health.json` 中的最小健康状态。
- `registerCerebellumAlarmMatrix()` 可把 R2-1 全天固定北京时间闹钟矩阵注册到 `AlarmJobRegistry`，但不会调用 `start()` 或启动常驻进程。

说明：

- 这里只做 scheduler 生命周期组合，不直接连接行情、账户、broker 或 LLM。
- scheduler runner 只负责在交易时段调起注入的回调；回调内部是否读取行情、生成研究或写入报告必须由上层显式注入 mock 或真实实现。
- 当前 P3-2 只用 `triggerOnce()` 验证 mock paper research loop，不调用 `start()`，不启动真实常驻进程。
- R2-1 只用 `AlarmJobRegistry.runDue(now)` 手动触发固定闹钟，构造 `CerebellumAlarmTask` 和 metadata-only context package；不请求网络、不调用真实 LLM、不接 broker。
- R1-1 的 `MarketSentinelDaemon` 只启动注入的任务。默认任务是 mock no-op，只写 scheduler 审计 metadata；不会读取行情、不会调用真实 LLM、不会连接 broker、不会写账户。
- R1-2 的 health/heartbeat 只记录 runtimeId、taskId、状态、时间、最近错误类型和脱敏错误摘要；不记录密钥、账号、完整研究正文或堆栈。
- 后续 `bootstrap()` 和 `createContainer()` 可以复用这个组合入口。

## Health 和 Heartbeat

开发态 daemon 会写入：

- `memory/logs/runtime-health.json`：当前 health snapshot。
- `memory/logs/heartbeat-YYYY-MM-DD.jsonl`：append-only heartbeat metadata。

状态规则：

- 启动成功后为 `running`。
- task 成功时更新 heartbeat。
- task 异常时 health 变为 `degraded`，记录 `lastError.errorType`、`lastError.message` 和 `lastError.occurredAt`。
- 停止后 health 变为 `stopped`，并记录 `stoppedAt`。

所有 metadata 写入前会脱敏 `apiKey`、`token`、`password`、`secret`、`account` 等字段，并截断长文本。

## 启动模式

- `cli`：一次性命令。
- `sentinel`：盘中哨兵常驻。
- `scheduler`：固定闹钟常驻。
- `api`：HTTP 服务。
- `worker`：后台任务。

## 验收

- 启动失败有明确错误。
- 缺 API key 时可退到 mock provider。
- 默认不会开启实盘交易。
- 集成测试 `tests/integration/scheduler-paper-research-loop.test.ts` 验证交易时段内可调起一次 mock 闭环回调、非交易时段跳过、同 job 不重入、回调失败返回 `failed` 后 runner 仍可继续触发。
- 集成测试 `tests/integration/market-sentinel-daemon.test.ts` 验证开发态 daemon 的启动、停止、重复启动保护、错误审计、health 和 heartbeat；测试使用 fake timers 和临时目录，不启动真实长驻进程。
- 集成测试 `tests/integration/cerebellum-alarm-runtime.test.ts` 验证固定闹钟 runtime 注册只生成计划任务，不启动 daemon、不联网、不接 broker。

## 边界

- runtime 不直接请求网络。
- runtime 不直接调用真实 LLM。
- runtime 不直接连接 broker。
- runtime 不直接写账户。
- mock 闭环测试必须使用临时 `memory` 目录。
- health/heartbeat 不可保存密钥、账号、完整 prompt、完整研究正文或错误堆栈。
