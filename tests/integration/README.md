# Integration Tests

集成测试覆盖基础设施和用例组合。

## 必测

- JSON 原子写入。已由 `tests/integration/json-store.test.ts` 覆盖。
- schema 校验失败不写入。
- 模拟账户初始化 dry-run、写入、重复拒绝、reset 备份。已由 `tests/integration/paper-account-initialization.test.ts` 覆盖。
- PaperBroker 买卖闭环、拒单、`intent_id` 防重复、PolicyEngine 接入。已由 `tests/integration/paper-broker.test.ts` 覆盖。
- 行情 provider mock。Tencent quote 已由 `tests/integration/tencent-quote-provider.test.ts` 覆盖。
- 小脑单次检查当前由 `tests/unit/market-sentinel.test.ts` 覆盖；Scheduler 本轮只验证任务生命周期，后续组合真实行情和持仓时再补端到端测试。
- Scheduler 北京时间、固定闹钟、盘中循环、任务防重入和优雅停止。已由 `tests/integration/scheduler.test.ts` 覆盖。
- BrainProvider mock 结构化输出。已由 `tests/unit/brain-provider.test.ts` 覆盖。
- 报告生成写入 `memory/reports`、重复写入备份、坏结构化输出不落盘。已由 `tests/integration/report-generation.test.ts` 覆盖。
- TradingAgents-CN 最小研究适配、执行字段隔离、超时降级、失败抛错和 `memory/research` 写入备份。已由 `tests/integration/trading-agents-cn-adapter.test.ts` 覆盖。

## 要求

- 使用临时目录。
- 不调用真实券商。
- 真实网络测试默认跳过。

Tencent quote 网络 smoke test 默认跳过，需要 `TENCENT_QUOTE_NETWORK=1`。
