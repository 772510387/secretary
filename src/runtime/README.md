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

当前会装配：

- `BeijingClock`
- `JobLock`
- `AlarmJobRegistry`
- `GracefulShutdown`
- `createMarketSentinelRunner()`

说明：

- 这里只做 scheduler 生命周期组合，不直接连接行情、账户、broker 或 LLM。
- 后续 `bootstrap()` 和 `createContainer()` 可以复用这个组合入口。

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
