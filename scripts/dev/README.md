# Dev Scripts

开发辅助脚本。

## 未来脚本

- `doctor.ts`：环境检查。
- `validate-schemas.ts`：校验 schema。
- `seed-paper-account.ts`：已实现，初始化模拟账户。
- `research-once.ts`：已实现，使用 mock runner 手动生成一次研究报告并写入 `memory/research`。
- `market-sentinel-daemon.ts`：已实现，启动开发态 MarketSentinel mock daemon，并写入 scheduler 审计 metadata。
- `replay-audit.ts`：回放审计事件。
- `mock-quotes.ts`：生成测试行情。

## 当前命令

```powershell
npm run seed:paper
npm run seed:paper -- --write
npm run seed:paper -- --write --reset
npm run research:once -- --symbol 000636 --market SZSE --date 2026-06-13 --objective "生成一次安全研究报告"
npm run sentinel:dev -- --run-ms 1000 --allow-outside-session
```

`seed:paper` 默认是 dry-run，不写文件。

`--write` 会写入：

- `memory/portfolio/account.json`
- `memory/portfolio/positions.json`
- `memory/portfolio/trades.jsonl`
- `memory/logs/audit-YYYY-MM-DD.jsonl`

已有账户文件时会拒绝覆盖，必须显式传 `--reset`。

`research:once` 默认使用 `runResearchOnce` 的本地 mock runner，不联网、不读取真实 TradingAgents-CN、不连接 broker、不写账户。它会直接写入：

- `memory/research/YYYY-MM-DD/{reportId}.json`
- `memory/logs/audit-YYYY-MM-DD.jsonl`

常用参数：

- `--symbol <code>`：必填，6 位 A 股代码。
- `--market <SSE|SZSE>`：必填，交易所。
- `--date <YYYY-MM-DD>`：必填，交易日。
- `--objective <text>`：必填，研究目标。
- `--name <text>`：可选，股票名称。
- `--task-id <id>`：可选，自定义任务 id。
- `--at <datetime>`：可选，固定生成和审计时间。
- `--memory-dir <path>`：可选，覆盖配置里的 `storage.memoryDir`，便于本地 smoke test 写到临时目录。

脚本会输出 JSON，包含 `reportPath`、`auditLogPath` 和 `degraded` 状态。

`sentinel:dev` 默认使用 mock task，只验证 scheduler daemon 生命周期、审计写入、runtime health 和 heartbeat，不联网、不调用真实 LLM、不读取 TradingAgents-CN、不连接 broker、不写账户。默认按 A 股交易时段调度；本地 smoke 可显式传 `--allow-outside-session` 放宽为全天触发。常用参数：

- `--run-ms <ms>`：运行指定毫秒后自动停止，便于本地 smoke 和测试。
- `--interval-ms <ms>`：盘中循环间隔。
- `--outside-session-interval-ms <ms>`：非交易时段循环间隔。
- `--memory-dir <path>`：覆盖配置里的 `storage.memoryDir`。
- `--at <datetime>`：固定 scheduler/audit 时间。
- `--allow-outside-session`：本地 smoke 专用，显式允许非交易时段触发 mock task。

## 要求

- 默认不改真实数据。
- 写入前打印目标路径。
- 支持 dry-run。

`research:once` 是本清单的例外：它的目标就是生成并写入一份 mock 研究报告；写入范围限定在 `memory/research` 和审计日志，不进入 broker 或账户链路。
