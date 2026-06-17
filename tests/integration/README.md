# Integration Tests

集成测试覆盖基础设施和用例组合。

## 必测

- JSON 原子写入。已由 `tests/integration/json-store.test.ts` 覆盖。
- schema 校验失败不写入。
- 审计日志 JSONL 追加、schema 校验和覆盖前备份。已由 `tests/integration/audit-log-writer.test.ts` 覆盖。
- 模拟账户初始化 dry-run、写入、重复拒绝、reset 备份。已由 `tests/integration/paper-account-initialization.test.ts` 覆盖。
- PaperBroker 买卖闭环、拒单、`intent_id` 防重复、PolicyEngine 接入。已由 `tests/integration/paper-broker.test.ts` 覆盖。
- ManualConfirmBroker paper-only 门禁，覆盖 approved handoff、未确认/拒绝/过期/撤销拦截、PolicyEngine/RiskEngine 重跑、handoff 审计和拒绝 live delegate。已由 `tests/integration/manual-confirm-broker.test.ts` 覆盖。
- LiveTradingSafetyStore 和 LiveTradingGate，覆盖账户 allowlist、kill switch 持久化、缺 allowlist 默认拒绝、active kill switch 阻断、metadata-only 审计和不创建订单/交易文件。已由 `tests/integration/live-trading-safety.test.ts` 覆盖。
- 行情 provider mock。Tencent quote 已由 `tests/integration/tencent-quote-provider.test.ts` 覆盖。
- 历史行情 provider mock。Tencent history 已由 `tests/integration/tencent-history-provider.test.ts` 覆盖，包含 qfq/day 解析、HTTP 失败、空响应和超时。
- 指数 provider mock。Tencent index 已由 `tests/integration/tencent-index-provider.test.ts` 覆盖，包含指数行解析、默认指数集合、HTTP 失败、空响应、坏数据、超时和科创 50 不改变主板交易限制。
- 小脑单次检查当前由 `tests/unit/market-sentinel.test.ts` 覆盖；Scheduler 本轮只验证任务生命周期，后续组合真实行情和持仓时再补端到端测试。
- Scheduler 北京时间、固定闹钟、盘中循环、任务防重入和优雅停止。已由 `tests/integration/scheduler.test.ts` 覆盖。
- MarketSentinel daemon 开发入口启动、停止、重复启动保护、运行错误审计、health 和 heartbeat。已由 `tests/integration/market-sentinel-daemon.test.ts` 覆盖，使用 fake timers 和临时目录，不启动真实长驻进程。
- Runtime health store 写入 `runtime-health.json` 和 `heartbeat-YYYY-MM-DD.jsonl`，并验证 metadata 脱敏。已由 `tests/integration/runtime-health-store.test.ts` 覆盖。
- BrainProvider mock 结构化输出。已由 `tests/unit/brain-provider.test.ts` 覆盖。
- 报告生成写入 `memory/reports`、重复写入备份、坏结构化输出不落盘。已由 `tests/integration/report-generation.test.ts` 覆盖。
- TradingAgents-CN 最小研究适配、执行字段隔离、超时降级、失败抛错、`memory/research` 写入备份和研究写入审计。已由 `tests/integration/trading-agents-cn-adapter.test.ts` 覆盖。
- TradingAgents-CN 子进程 runner fake subprocess，覆盖 stdout JSON、`SECRETARY_RESULT_JSON:` 前缀、非零退出、坏 JSON、空输出、超时终止和 stderr 脱敏。已由 `tests/integration/trading-agents-cn-subprocess-runner.test.ts` 覆盖。
- `runResearchOnce` 一次性研究用例默认 mock、只返回不落盘、显式写入 `memory/research` 和拒绝执行字段。已由 `tests/integration/run-research-once.test.ts` 覆盖。
- mock paper research loop 从 MarketSentinel 事件构造 ResearchTask，经 TradingAgents-CN mock runner 写入研究报告，再生成常规报告并验证审计元数据。已由 `tests/integration/paper-research-loop.test.ts` 覆盖。
- scheduler runner 通过 `triggerOnce()` 调起一次 mock paper research loop，覆盖交易时段触发、非交易时段跳过、同 job 不重入和失败后可恢复。已由 `tests/integration/scheduler-paper-research-loop.test.ts` 覆盖。
- `ProposalMemoryStore` 写入 `memory/proposals`、覆盖前备份、提案写入审计和坏提案不落盘。已由 `tests/integration/proposal-memory.test.ts` 覆盖，包含 `trade_intent_review` 和 `memory_write_review`。
- `MemoryRegistry` 分类列文档、时间范围过滤、关键词搜索脱敏、搜索返回 `path/summary/updatedAt/metadata` 和最近研究/报告元数据读取。已由 `tests/integration/memory-registry.test.ts` 覆盖。
- 复盘报告 metadata 标准化。已由 `tests/integration/report-generation.test.ts` 和 `tests/integration/memory-registry.test.ts` 覆盖 `period`、`symbols`、`marketSummary`、`decisionSummary`、`riskNotes`、`linkedAuditIds`，并验证不返回完整正文。

## 要求

- 使用临时目录。
- 不调用真实券商。
- 真实网络测试默认跳过。

Tencent quote 网络 smoke test 默认跳过，需要 `TENCENT_QUOTE_NETWORK=1`。
Tencent history 网络 smoke test 默认跳过，需要 `TENCENT_HISTORY_NETWORK=1`。
Tencent index 当前只保留 mock fetch 测试，未设置默认真实网络 smoke。
DashScope Qwen 网络 smoke test 默认跳过，需要 `DASHSCOPE_BRAIN_NETWORK=1` 和本机 `DASHSCOPE_API_KEY`。
Webhook notifier 网络 smoke test 默认跳过，需要 `WEBHOOK_NOTIFIER_NETWORK=1` 和 `WEBHOOK_NOTIFIER_URL`。

- `Cerebellum` 固定闹钟 runtime 注册由 `tests/integration/cerebellum-alarm-runtime.test.ts` 覆盖，只调用 `AlarmJobRegistry.runDue()`，不启动 daemon、不联网、不接 broker。
- `Notification` console/file/webhook notifier 由 `tests/integration/notification-notifier.test.ts` 覆盖，file 输出使用 JSONL 和原子写入，webhook 默认使用 mock fetch，不接微信。
- `NotificationRouter` 路由和升级策略由 `tests/integration/notification-router.test.ts` 覆盖，验证默认 console/file、外部通道显式开启、critical 审计先写和缺审计 sink 失败。
- `WatchlistMemoryStore` 由 `tests/integration/watchlist-memory.test.ts` 覆盖，使用临时目录验证人工 seed/import、三类池、原子写入备份和 metadata-only 审计。
