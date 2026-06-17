# Secretary 下一步操作清单

生成日期：2026-06-12
状态更新：2026-06-13

这份清单记录从项目骨架推进到 T014 的任务拆分和验收口径。T001-T014 已经完成，后续推进请优先使用 `docs/requirement/post-t014-interaction-checklist.md`。

## 0. 当前状态

已经完成：

- 项目目录骨架。
- 每个模块 README。
- 架构文档。
- AI 协作规则。
- TypeScript 基础配置。
- 配置模板。
- T001 ConfigLoader。
- T002 JsonStore 和 AtomicFileWriter。
- T003 基础数据 schema。
- T004 初始化模拟账户。
- T005 Portfolio 计算。
- T006 PaperBroker。
- T007 PolicyEngine。
- T008 RiskEngine。
- T009 TencentQuoteProvider。
- T010 MarketSentinel 单次检查。
- T011 Scheduler。
- T012 BrainProvider 抽象和 MockBrainProvider。
- T013 报告生成。
- T014 TradingAgents-CN Research Adapter 最小版本。

当前仍未完成或不应急着做：

- 研究报告写入审计补强。
- 手动研究入口和开发脚本。
- 哨兵、研究、报告和审计的端到端模拟闭环。
- 人工确认提案模型。
- T015 `ManualConfirmBroker` 及之后的实盘预备任务。
- 真实 BrainProvider 和真实 TradingAgents-CN runner 接入评估。
- 真实 broker 接入。模拟盘稳定前不要实现自动实盘买入。

## 1. 当前基线检查

继续开发前，建议在 `D:\Project\main\secretary` 运行：

```powershell
npm run doctor
npm run typecheck
npm test
```

当前默认配置仍应保持：

```env
LIVE_TRADING=false
BRAIN_PROVIDER=mock
BROKER_PROVIDER=paper
MARKET_PROVIDER=tencent
TIMEZONE=Asia/Shanghai
```

Gemini、DashScope Qwen、OpenAI key 可以继续不填，等模拟盘闭环稳定后再评估真实 provider 接入。

后续交互入口：

```text
请按 docs/requirement/post-t014-interaction-checklist.md 执行 <任务编号>。
```

## 2. 推进原则

不要一口气说“把整个系统做完”。

推荐每次只交给 AI 一个任务，格式如下：

```text
请按 docs/ai/context-map.md 加载上下文，实现 T001 ConfigLoader。
完成后补测试，更新相关 README，并运行可用验证。
```

每个任务完成后，再进入下一个任务。

## 3. MVP 总目标

MVP 完成时，系统应该可以：

- 初始化一个 2 万元模拟账户。
- 读取和写入账户 JSON。
- 查询实时行情。
- 模拟买入和卖出。
- 执行主板、T+1、100 股、现金、持仓规则。
- 执行单股 40% 和 8% 止损风控。
- 盘中定时检查持仓异动。
- 生成基础日报。
- 所有关键动作写入审计日志。

## 4. 第一阶段：基础工程

### T001 ConfigLoader

状态：已完成，2026-06-12。

目标：

- 实现配置加载。
- 读取 `.env` 和 `config/default.example.json`。
- 输出强类型 `AppConfig`。
- 默认 `LIVE_TRADING=false`。

目标目录：

- `src/config`
- `tests/unit` 或 `tests/integration`

验收：

- 缺 `.env` 不崩。
- 缺 key 时可以使用 mock provider。
- 实盘默认关闭。
- 配置非法时报清楚错误。

产出：

- `src/config/schema.ts`
- `src/config/env.ts`
- `src/config/errors.ts`
- `src/config/loader.ts`
- `src/config/index.ts`
- `tests/unit/config-loader.test.ts`
- `scripts/dev/doctor.ts`

交给 AI 的提示词：

```text
请按 docs/ai/context-map.md 加载上下文，实现 T001 ConfigLoader。
目标目录是 src/config。
要求读取 .env 和 config/default.example.json，输出强类型 AppConfig，默认 LIVE_TRADING=false。
补测试并运行验证。
```

### T002 JsonStore 和原子写入

状态：已完成，2026-06-12。

目标：

- 实现 JSON 文件读取、schema 校验、原子写入、写入前备份。

目标目录：

- `src/infrastructure/storage`
- `tests/integration`

验收：

- 写入失败不破坏原文件。
- 非法 JSON 或非法 schema 会拒绝。
- 能在临时目录测试。

产出：

- `src/infrastructure/storage/errors.ts`
- `src/infrastructure/storage/backup-manager.ts`
- `src/infrastructure/storage/atomic-file-writer.ts`
- `src/infrastructure/storage/json-store.ts`
- `src/infrastructure/storage/index.ts`
- `tests/integration/json-store.test.ts`

交给 AI 的提示词：

```text
请实现 T002 JsonStore 和 AtomicFileWriter。
读取 src/infrastructure/storage/README.md 和 tests/integration/README.md。
要求支持读取、校验、原子写入、写入前备份，并补集成测试。
```

### T003 基础 Schema

状态：已完成，2026-06-12。

目标：

- 定义账户、持仓、交易流水、审计事件 schema。

目标目录：

- `data/schemas`
- `src/domain/portfolio`
- `src/domain/audit`

验收：

- schema 能校验正例和反例。
- 金额、数量、时间字段约束明确。

产出：

- `src/domain/shared/schemas.ts`
- `src/domain/portfolio/schemas.ts`
- `src/domain/audit/schemas.ts`
- `data/schemas/account.schema.json`
- `data/schemas/position.schema.json`
- `data/schemas/trade-record.schema.json`
- `data/schemas/audit-event.schema.json`
- `tests/fixtures/*.valid.json`
- `tests/fixtures/*.invalid.json`
- `tests/unit/domain-schemas.test.ts`

交给 AI 的提示词：

```text
请实现 T003 基础数据 schema。
范围：account、position、trade-record、audit-event。
要求补 fixtures 和 schema 校验测试。
```

## 5. 第二阶段：模拟账户和交易

### T004 初始化模拟账户

状态：已完成，2026-06-12。

目标：

- 生成初始 2 万元模拟账户。
- 写入 `memory/portfolio/account.json`。
- 初始化空持仓和空交易流水。

目标目录：

- `data/seeds`
- `memory/portfolio`
- `scripts/dev`

验收：

- 重复初始化不会误覆盖，除非显式 `--reset`。
- 初始化写审计日志。

产出：

- `src/app/initialize-paper-account.ts`
- `src/infrastructure/storage/paper-account-memory.ts`
- `scripts/dev/seed-paper-account.ts`
- `data/seeds/paper-account.seed.json`
- `memory/portfolio/account.json`
- `memory/portfolio/positions.json`
- `memory/portfolio/trades.jsonl`
- `memory/logs/audit-2026-06-12.jsonl`
- `tests/integration/paper-account-initialization.test.ts`

交给 AI 的提示词：

```text
请实现 T004 初始化模拟账户。
初始资金 20000，写入 memory/portfolio。
重复初始化不能误覆盖，除非显式 reset。
补测试或 dry-run 验证。
```

### T005 Portfolio 计算

状态：已完成，2026-06-12。

目标：

- 计算现金、持仓市值、浮盈浮亏、仓位比例、可卖数量。

目标目录：

- `src/domain/portfolio`
- `tests/unit`

验收：

- 成本价计算准确。
- 当日买入不可卖。
- 持仓市值和仓位比例准确。

产出：

- `src/domain/portfolio/calculations.ts`
- `tests/unit/portfolio-calculations.test.ts`

计算口径：

- 金额 2 位。
- 价格/成本价 4 位。
- 比例 6 位。
- 保守可卖数量取 `availableQuantity` 和 T+1 计算值的较小值。

交给 AI 的提示词：

```text
请实现 T005 Portfolio 计算。
重点覆盖现金、持仓、市值、成本、浮盈浮亏、T+1 可卖数量。
所有金额和数量逻辑必须有单元测试。
```

### T006 PaperBroker

状态：已完成，2026-06-12。

目标：

- 实现模拟买入、卖出、撤单或拒单。

目标目录：

- `src/domain/trading`
- `src/infrastructure/broker`
- `tests/integration`

验收：

- 买入扣现金。
- 卖出加现金。
- 生成交易流水。
- 现金不足拒绝。
- 可卖数量不足拒绝。
- `intent_id` 防重复。

产出：

- `src/domain/trading/schemas.ts`
- `src/domain/trading/orders.ts`
- `src/domain/trading/index.ts`
- `src/infrastructure/broker/paper-broker.ts`
- `src/infrastructure/broker/index.ts`
- `tests/integration/paper-broker.test.ts`

说明：

- T006 已实现订单模型、模拟买卖、拒单、交易流水和订单审计。
- T006 尚不实现主板过滤和 100 股整数，这些属于 T007。
- T006 尚不实现单股 40% 和 8% 止损，这些属于 T008。

交给 AI 的提示词：

```text
请实现 T006 PaperBroker。
必须经过 trading domain 的订单模型，支持买入、卖出、拒单、intent_id 防重复。
补集成测试。
```

## 6. 第三阶段：交易规则和风控

### T007 PolicyEngine

状态：已完成，2026-06-12。

目标：

- 主板过滤。
- 100 股整数。
- T+1。
- 现金和持仓基础规则。

目标目录：

- `src/domain/risk`
- `tests/unit`

验收：

- 科创板、创业板等非主板默认拒绝。
- 非 100 股整数买入拒绝。
- 当日买入卖出拒绝。

产出：

- `src/domain/risk/policy-engine.ts`
- `src/domain/risk/index.ts`
- `tests/unit/policy-engine.test.ts`
- `tests/integration/paper-broker.test.ts` 已补充 PolicyEngine 接入验证。

说明：

- 默认只允许 A 股主板。
- 买入默认必须 100 股整数倍。
- 卖出允许非 100 股，但不能超过 T+1 可卖数量。
- PaperBroker 已接入 PolicyEngine。

交给 AI 的提示词：

```text
请实现 T007 PolicyEngine。
覆盖主板过滤、100 股整数、T+1、现金和持仓基础规则。
补单元测试。
```

### T008 RiskEngine

状态：已完成，2026-06-12。

目标：

- 单股 40% 仓位上限。
- 8% 硬止损。
- 单日亏损限制。
- 禁买和熔断状态。

目标目录：

- `src/domain/risk`
- `tests/unit`

验收：

- 超过单股上限拒绝买入。
- 触发 8% 止损产生 critical 风险事件。
- 熔断后不能新增买入。

产出：

- `src/domain/risk/risk-engine.ts`
- `tests/unit/risk-engine.test.ts`

说明：

- 未接入 broker。
- 只返回 `RiskCheckResult`。
- 单股上限、单日亏损、禁买、熔断会阻断买入。
- 8% 硬止损会产生 critical 风险事件，但自身不自动执行交易。

交给 AI 的提示词：

```text
请实现 T008 RiskEngine。
覆盖单股 40%、8% 止损、单日亏损限制、禁买和熔断。
不要接入 broker，只返回 RiskCheckResult。
补单元测试。
```

## 7. 第四阶段：行情和小脑

### T009 TencentQuoteProvider

状态：已完成，2026-06-12。

目标：

- 接腾讯行情接口。
- 标准化为 `QuoteSnapshot`。

目标目录：

- `src/domain/market`
- `src/infrastructure/providers`
- `tests/integration`

验收：

- 能查询单只股票。
- 能批量查询。
- 停牌、空数据、网络失败有错误处理。

产出：

- `src/domain/market/schemas.ts`
- `src/domain/market/symbols.ts`
- `src/domain/market/index.ts`
- `src/infrastructure/providers/errors.ts`
- `src/infrastructure/providers/tencent-quote-provider.ts`
- `src/infrastructure/providers/index.ts`
- `tests/integration/tencent-quote-provider.test.ts`

说明：

- mock fetch 测试默认运行。
- 真实网络 smoke test 默认跳过，需要 `TENCENT_QUOTE_NETWORK=1`。
- `changePct` 统一保存为小数比例，不是百分数字符串。

交给 AI 的提示词：

```text
请实现 T009 TencentQuoteProvider。
把腾讯行情结果转换成 QuoteSnapshot。
网络测试默认可跳过，必须支持 mock 测试。
```

### T010 MarketSentinel 单次检查

状态：已完成，2026-06-12。

目标：

- 不先做常驻循环，只做一次检查函数。
- 输入持仓和行情，输出小脑事件。

目标目录：

- `src/domain/cerebellum`
- `src/app`
- `tests/unit`

验收：

- 1 分钟急跌/急涨能触发。
- 持仓跌破止损能触发。
- 告警冷却生效。
- 不调用 LLM。

产出：

- `src/domain/cerebellum/schemas.ts`
- `src/domain/cerebellum/market-sentinel.ts`
- `src/domain/cerebellum/index.ts`
- `src/app/run-market-sentinel-once.ts`
- `tests/unit/market-sentinel.test.ts`

说明：

- `checkMarketSentinel` 是单次检查纯函数，不启动常驻循环。
- 支持 `price_surge`、`price_drop`、`position_stop_loss` 三类事件。
- 默认 60 秒内 2% 急涨急跌触发 warning。
- 默认持仓相对成本价亏损 8% 触发 critical。
- 冷却键为 `eventType:market:symbol`，默认 10 分钟。
- 当前不接入 broker，不调用 LLM，不自动交易。

交给 AI 的提示词：

```text
请实现 T010 MarketSentinel 单次检查。
只实现一次检查，不做常驻进程。
输入行情和持仓，输出 CerebellumEvent。
补单元测试。
```

### T011 Scheduler

状态：已完成，2026-06-12。

目标：

- 北京时间固定闹钟。
- 盘中循环 runner。

目标目录：

- `src/infrastructure/scheduler`
- `src/runtime`
- `tests/integration`

验收：

- 非交易时段不高频轮询。
- 任务不会重入。
- 支持优雅停止。

产出：

- `src/infrastructure/scheduler/types.ts`
- `src/infrastructure/scheduler/beijing-clock.ts`
- `src/infrastructure/scheduler/trading-session.ts`
- `src/infrastructure/scheduler/job-lock.ts`
- `src/infrastructure/scheduler/alarm-job-registry.ts`
- `src/infrastructure/scheduler/market-sentinel-runner.ts`
- `src/infrastructure/scheduler/graceful-shutdown.ts`
- `src/infrastructure/scheduler/index.ts`
- `src/runtime/scheduler-runtime.ts`
- `src/runtime/index.ts`
- `tests/integration/scheduler.test.ts`

说明：

- `BeijingClock` 统一输出北京时间结构。
- `TradingDayScheduler` 默认识别周一到周五、`09:30-11:30`、`13:00-15:00`。
- 当前不内置中国节假日交易日历。
- `AlarmJobRegistry` 支持固定北京时间闹钟，同一任务同一分钟只触发一次。
- `MarketSentinelRunner` 默认盘中 `3000ms` 循环，非交易时段 `60000ms` 降频。
- `JobLock` 保证同一 `jobId` 不重入。
- `GracefulShutdown` 支持集中停止信号和 shutdown hook。
- 当前只调度回调，不请求行情、不读写账户、不调用 LLM、不执行交易。

交给 AI 的提示词：

```text
请实现 T011 Scheduler。
重点是北京时间、固定闹钟、盘中循环、任务防重入和优雅停止。
补集成测试。
```

## 8. 第五阶段：大脑和报告

### T012 BrainProvider

状态：已完成，2026-06-12。

目标：

- 实现统一 `BrainProvider`。
- 先实现 `MockBrainProvider`。
- 再接 Gemini/DashScope Qwen/OpenAI。

目标目录：

- `src/domain/brain`
- `src/infrastructure/providers`
- `tests/unit`

验收：

- mock provider 可稳定返回结构化输出。
- provider 缺 key 时错误清楚。
- 模型输出必须校验。

产出：

- `src/domain/brain/errors.ts`
- `src/domain/brain/schemas.ts`
- `src/domain/brain/provider.ts`
- `src/domain/brain/validator.ts`
- `src/domain/brain/index.ts`
- `src/infrastructure/providers/mock-brain-provider.ts`
- `src/infrastructure/providers/brain-provider-credentials.ts`
- `tests/unit/brain-provider.test.ts`

说明：

- `BrainProvider` 已定义统一 `generate(input, options)` 接口。
- `BrainInput` 支持任务类型、上下文、输出约束和工具权限。
- `BrainOutput` 支持摘要、结构化结果、引用、置信度和待审核提案。
- `ToolPermission.canExecute` 当前固定为 `false`。
- `trade_intent_draft` 等提案必须 `requiresReview=true`，不能直接执行。
- `MockBrainProvider` 不调用真实 API，会稳定返回结构化输出并强制校验。
- `requireBrainProviderApiKey()` 已提供真实 provider 缺 key 的清晰错误。
- OpenAI、Gemini、DashScope Qwen 真实 API 尚未接入。

交给 AI 的提示词：

```text
请实现 T012 BrainProvider 抽象和 MockBrainProvider。
先不要接真实 API。
要求输出结构化结果并做校验。
补测试。
```

### T013 报告生成

状态：已完成，2026-06-12。

目标：

- 生成盘前、午间、收盘、每日自省报告。

目标目录：

- `src/app`
- `memory/reports`
- `tests/integration`

验收：

- 报告包含时间、账户、持仓、行情摘要、风险、建议。
- 建议不能直接执行。
- 报告写入 `memory/reports`。

产出：

- `src/app/report-generation.ts`
- `src/infrastructure/storage/report-memory.ts`
- `tests/integration/report-generation.test.ts`
- `memory/reports/README.md`

说明：

- 支持 `pre_market_plan`、`midday_review`、`closing_review`、`daily_reflection` 四类报告。
- 当前通过注入的 `MockBrainProvider` 生成结构化内容，不调用真实模型 API。
- 报告会写入 `memory/reports/YYYY-MM-DD/{reportType}.json`。
- 报告包含账户摘要、持仓摘要、行情摘要、风险摘要、事实、推断、建议、`BrainOutput` 和 `contentMarkdown`。
- 建议统一为 `executable=false`，不能直接进入 broker。
- 重复写入同一报告会创建备份。
- 如果大脑结构化输出校验失败，报告不会落盘。

交给 AI 的提示词：

```text
请实现 T013 报告生成。
先用 MockBrainProvider，生成盘前、午间、收盘和每日自省报告。
写入 memory/reports，并补集成测试。
```

## 9. 第六阶段：研究适配器

### T014 TradingAgents-CN Research Adapter

状态：已完成，2026-06-12。

目标：

- 把 TradingAgents-CN 作为可选深度研究顾问。
- 输出统一 `ResearchReport`。

目标目录：

- `src/domain/research`
- `src/infrastructure/providers`
- `memory/research`

验收：

- 不复制其专有 `app/` 和 `frontend/`。
- 不允许直接下单。
- 超时和失败有降级。
- 输出可以写入研究记忆。

产出：

- `src/domain/research/errors.ts`
- `src/domain/research/schemas.ts`
- `src/domain/research/validator.ts`
- `src/domain/research/index.ts`
- `src/infrastructure/providers/trading-agents-cn-adapter.ts`
- `src/infrastructure/storage/research-memory.ts`
- `tests/integration/trading-agents-cn-adapter.test.ts`

说明：

- `TradingAgentsCnAdapter` 当前是最小适配层，不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。
- 适配器通过注入的 `runner` 接未来真实 TradingAgents-CN 调用。
- 适配器只返回 `ResearchReport`，不写账户、不接 broker、不执行交易。
- 外部输出里的 `orders`、`execution` 等执行字段只记录到 `metadata.ignoredExecutionFields`，不会进入订单链路。
- 默认超时 `30000ms`。
- 错误或超时默认返回 `degraded=true` 的降级 `ResearchReport`。
- `fallbackOnError=false` 时会抛出 `ResearchProviderError`。
- `ResearchMemoryStore` 可把报告写入 `memory/research/YYYY-MM-DD/{reportId}.json`。
- `TradeIntentDraft` 固定为 `requiresReview=true` 和 `executable=false`。

交给 AI 的提示词：

```text
请实现 T014 TradingAgents-CN Research Adapter 的最小版本。
读取 docs/ai/prompts/research-adapter.md。
要求只输出 ResearchReport，不进入交易执行。
```

## 10. 第七阶段：实盘预备，不急着做

这些任务等模拟盘稳定后再做：

- T015 `ManualConfirmBroker`
- T016 真实 broker 抽象补强
- T017 QMT/PTrade 调研和接口适配
- T018 实盘熔断和应急停机
- T019 对账系统

在此之前不要实现自动实盘买入。

## 11. 每次任务完成后的检查

完成任意任务后，让 AI 执行：

```text
请按 docs/ai/checklists/change-checklist.md 检查本次改动。
说明完成了什么、验证了什么、还剩什么风险。
```

## 12. 你现在应该做什么

T001-T014 已完成，不要再从 T001 重新开始。P0-1 文档状态校准已完成，后续按 `docs/requirement/post-t014-interaction-checklist.md` 推进。

推荐顺序：

1. P0-2 Git 发布前检查。
2. P1-1 ResearchMemoryStore 写入审计日志。
3. P2-1 `runResearchOnce` 应用用例。
4. P2-2 `research:once` 开发脚本。
5. P3-1 单次闭环集成测试。
6. P3-2 盘中 runner 组合验证。
7. P4-1 TradeIntentDraft 到人工确认提案。
8. P4-2 ManualConfirmBroker 设计文档。
9. P5 外部能力评估。

下一句可以直接发：

```text
请执行 docs/requirement/post-t014-interaction-checklist.md 的 P0-2。
只运行 Git 发布前检查命令，不修改文件。
把发现的问题按风险排序说明。
```

做到 P3-2 之后，再判断是否进入 T015。不要在 P3-2 之前实现真实 broker。
