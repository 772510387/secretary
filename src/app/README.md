# App Use Cases

`app` 放应用用例编排，不放底层规则。

## 需要实现

- `InitializePaperAccountUseCase`：已实现初始模拟账户 seed 构建和防误覆盖判断。
- `RunMarketSentinelUseCase`：已实现盘中哨兵循环中的单次检查包装。
- `GeneratePreMarketPlanUseCase`：已通过 `generateReport` 支持盘前计划。
- `GenerateMiddayReviewUseCase`：已通过 `generateReport` 支持午间复盘。
- `GenerateClosingReviewUseCase`：已通过 `generateReport` 支持收盘复盘。
- `GenerateDailyReflectionUseCase`：已通过 `generateReport` 支持每日自省。
- `RunResearchOnceUseCase`：已通过 `runResearchOnce` 支持一次性研究，可只返回报告或显式写入 `memory/research`。
- `HandleUserQueryUseCase`：已通过 `runWatchMarketOnce` 支持随时看盘，可返回结构化摘要和非执行报告草稿。
- `AgentPlannerUseCase`：`agent-planner.ts` 用模型驱动路由（`planAgentTurn` + `fulfilTurnPlan`）替代关键词分类，意图（问答 / 跑 SOP / 清库 / 建账户 / 模拟运维）由大脑判断，SOP 按 `sop-catalog` 描述选中；状态变更仍走确定性二次确认，模型不执行工具。模拟运维（单独重演昨日，或重演昨日、更新数据库、模拟今日的复合命令）先走确定性 fast-path，避免被模型误路由成只读复盘 SOP 或采纳错误日期。模型失败时降级到 `classifyAgentIntent`。`agent-router.ts` 保留为确定性兜底层。
- `CreateTradeIntentUseCase`：把研究建议转成交易意图草案。
- `ExecutePaperOrderUseCase`：执行模拟盘订单。
- `BuildFunnelExecutionConstraintsUseCase`：在模型选择前按 A 股模拟盘规则生成可执行买卖候选，覆盖主板过滤、现金、单股仓位、100 股买入、T+1 可卖和具体股数/限价。
- `WriteMemoryProposalUseCase`：处理大脑提出的记忆写入提案。
- `KlineAsOfIndexSource`：用历史 K 线生成 as-of 四大指数上下文，供忠实重演使用，避免用实时指数污染历史节点。
- `PersistPeriodReviewUseCase`：把周/月/年复盘结果追加写入 `memory/weekly_reviews`、`memory/monthly_reviews`、`memory/yearly_reviews`。
- `TradingDayReviewUseCase`：从账户快照、成交账本、提案理由和持仓估值生成接地交易日复盘；覆盖最终战绩、操作统计、关键决策、价格-操作对照、逐节点逻辑表和数据边界，模型不得补数字。
- `BuildProblemFeedbackFactPackUseCase`：为飞书/agent 问责类反馈生成只读事实包，检查日期范围内 100 池快照、计划、提案、成交和报告证据；模型只负责解释和补救表达。
- `BuildOperationReviewContextUseCase`：为飞书/agent 操作复盘追问生成只读证据包，串联成交、订单、提案理由、当日计划、盘后快照、报告和审计线索；用于回答为什么买卖、卖了多少、时间戳和用户纠错。
- `AnalyzePotentialStocksUseCase`：把 `potential_stocks` / 选股漏斗 shortlist 生成潜力股池深度分析，覆盖核心逻辑、入选理由、买点/止损/目标/仓位、风险和跟踪点；只读、不下单、不写账户。

## 输入

- CLI/API/Webhook 解析后的 command。
- 当前账户和持仓。
- 行情快照。
- 研究报告。
- 运行配置。

## 输出

- 报告。
- 告警。
- 交易意图。
- 模拟订单结果。
- 记忆写入提案。
- 审计事件。

## 当前接口

```ts
import {
  buildInitialPaperAccountSeed,
  buildCerebellumAlarmTasks,
  assertCanInitializePaperAccount,
  generateDailyReports,
  planToolRuntimeRequests,
  runWatchMarketOnce,
  runResearchOnce,
  runMarketSentinelOnce,
} from "./src/app/index.js";

const seed = buildInitialPaperAccountSeed({ initialCash: 20000 });

const sentinelResult = runMarketSentinelOnce({
  quotes: [],
  positions: [],
});

const reportResults = await generateDailyReports({
  account,
  positions,
  quotes,
  brainProvider,
  writer,
  tradingDate: "2026-06-12",
});

const researchResult = await runResearchOnce({
  symbol: "000636",
  market: "SZSE",
  objective: "生成一次安全研究报告",
  now: "2026-06-12T08:30:00.000Z",
});

const storedResearchResult = await runResearchOnce({
  task: researchTask,
  writer: researchMemoryStore,
  writeToMemory: true,
});

const toolPlanResult = planToolRuntimeRequests({
  requests: [
    {
      requestId: "tool-request-001",
      requestedBy: { type: "brain", id: "mock-brain" },
      toolType: "propose_trade_intent",
      reason: "Mock idea for manual review.",
      payload: {
        symbol: "000636",
        market: "SZSE",
        side: "WATCH",
        rationale: "Human review only.",
      },
    },
  ],
});

const watchMarketResult = await runWatchMarketOnce({
  requestId: "watch-market-001",
  requestedAt: "2026-06-15T02:00:00.000Z",
  queryType: "symbol_snapshot",
  query: "现在 000636 怎么样",
  target: {
    symbol: "000636",
    market: "SZSE",
  },
});

const alarmTasks = buildCerebellumAlarmTasks({
  now: "2026-12-31T12:00:00.000Z",
  sources: [
    {
      sourceId: "rules-risk",
      category: "rules",
      relativePath: "memory/rules/risk.md",
      summary: "Rules summary only.",
    },
  ],
});
```

`runMarketSentinelOnce` 只编排小脑单次检查，不请求网络、不读写文件、不调用 LLM，也不触发 broker。

`generateReport` / `generateDailyReports` 通过注入的 `BrainProvider` 和 `ReportWriter` 编排报告生成。当前集成测试使用 `MockBrainProvider` 和 `ReportsMemoryStore`，输出写入 `memory/reports/YYYY-MM-DD/{reportType}.json`。

`runResearchOnce` 编排一次研究任务。默认使用本地 mock runner，不请求真实 TradingAgents-CN、不读取 `.env`、不触发 broker、不写账户；传入自定义 `ResearchRunner` 时仍会用 `ResearchReport` schema 校验输出。默认模式只返回结构化报告；只有显式设置 `writeToMemory: true` 且传入兼容 `ResearchMemoryStore.writeReport()` 的 writer 时，才写入 `memory/research/YYYY-MM-DD/{reportId}.json` 并由存储层产生审计。

`planToolRuntimeRequests` 批量编排大脑提出的结构化工具请求。它只做校验和计划生成：写记忆请求经过 `MemoryWritePolicy`，交易请求只生成待人工确认提案，禁止工具会被拒绝并产生审计元数据；不会执行 broker、账户写入、网络或模型调用。

`buildProblemFeedbackFactPack` 为“你确定看了吗 / 为什么只操作几支 / 上周有没有漏看”这类飞书反馈提供确定性证据包。它只读 `memory/market/pool-snapshots`、`memory/plans`、`memory/proposals`、`memory/portfolio/trades.jsonl` 和 `memory/reports`，输出覆盖缺口、证据路径和回答指引，不写账户、不写规则、不调用模型。

`buildOperationReviewContext` 为“今天为什么卖 / 早上是不是卖了 200 股 / 58.50 怎么定 / 这个时间是不是北京时间”这类飞书追问提供确定性证据包。它只读 `memory/portfolio`、`memory/proposals`、`memory/plans`、`memory/reports` 和 `memory/logs`，输出成交时间线、关联理由、账户快照和数据缺口，不写账户、不写规则、不调用模型。

`createTradingDayReviewFromMemory()` 读取 `memory/portfolio`、`memory/proposals` 和已归档快照，生成 `memory/reviews/YYYY-MM-DD/trading-day-review.md`。它会把 `tradedAt` 统一展示为北京时间，按成本批次计算可确认的已实现盈亏；成本、分时或理由缺失时明确写“未记录/未确认”，不会让模型补齐。

`runWatchMarketOnce` 编排用户主动“随时看盘”查询。它通过注入或默认 mock 的 QuoteProvider、HistoryProvider 和 MemoryRegistry 组装上下文，返回结构化摘要、非执行报告草稿和 metadata-only 审计事件；默认不联网、不调用真实 LLM、不写账户、不接 broker。当前大盘查询按传入标的集合聚合，尚未接指数 provider。

`buildCerebellumAlarmTasks` 根据固定北京时间闹钟矩阵生成小脑任务对象和上下文包。它不启动 scheduler、不调用真实 BrainProvider、不联网、不接 broker；上下文包只包含路径、摘要和必要元数据。

`KlineAsOfIndexSource` 只通过注入的 `HistoryProvider` 读取指数历史日 K，并按 `asOfDate`/`inclusive` 过滤；用于重演时不会读取实时指数。`persistPeriodReview()` 使用原子写入追加复盘 Markdown，只保存报告文本和元数据，不写账户、不下单、不改规则。

`analyzePotentialStocks()` 只使用注入的 `BrainProvider` 和调用方传入的候选池上下文，不读写文件、不联网、不接 broker。模型输出必须通过结构化 schema；失败时会基于确定性候选元数据降级生成同样格式的逐股报告。飞书 `pick_stocks` 路由会优先读取当前 `potential_stocks` 富信息，缺失时从 100 高关注池临时筛出 shortlist，再渲染成可直接发送的深度报告。

## 禁止

- 不直接写文件。
- 不直接请求网络。
- 不直接调用模型 SDK。
- 不直接调用券商 SDK。
