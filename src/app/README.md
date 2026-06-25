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

`runWatchMarketOnce` 编排用户主动“随时看盘”查询。它通过注入或默认 mock 的 QuoteProvider、HistoryProvider 和 MemoryRegistry 组装上下文，返回结构化摘要、非执行报告草稿和 metadata-only 审计事件；默认不联网、不调用真实 LLM、不写账户、不接 broker。当前大盘查询按传入标的集合聚合，尚未接指数 provider。

`buildCerebellumAlarmTasks` 根据固定北京时间闹钟矩阵生成小脑任务对象和上下文包。它不启动 scheduler、不调用真实 BrainProvider、不联网、不接 broker；上下文包只包含路径、摘要和必要元数据。

`KlineAsOfIndexSource` 只通过注入的 `HistoryProvider` 读取指数历史日 K，并按 `asOfDate`/`inclusive` 过滤；用于重演时不会读取实时指数。`persistPeriodReview()` 使用原子写入追加复盘 Markdown，只保存报告文本和元数据，不写账户、不下单、不改规则。

## 禁止

- 不直接写文件。
- 不直接请求网络。
- 不直接调用模型 SDK。
- 不直接调用券商 SDK。
