# App Use Cases

`app` 放应用用例编排，不放底层规则。

## 需要实现

- `InitializePaperAccountUseCase`：已实现初始模拟账户 seed 构建和防误覆盖判断。
- `RunMarketSentinelUseCase`：已实现盘中哨兵循环中的单次检查包装。
- `GeneratePreMarketPlanUseCase`：已通过 `generateReport` 支持盘前计划。
- `GenerateMiddayReviewUseCase`：已通过 `generateReport` 支持午间复盘。
- `GenerateClosingReviewUseCase`：已通过 `generateReport` 支持收盘复盘。
- `GenerateDailyReflectionUseCase`：已通过 `generateReport` 支持每日自省。
- `HandleUserQueryUseCase`：用户随时查询。
- `CreateTradeIntentUseCase`：把研究建议转成交易意图草案。
- `ExecutePaperOrderUseCase`：执行模拟盘订单。
- `WriteMemoryProposalUseCase`：处理大脑提出的记忆写入提案。

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
  assertCanInitializePaperAccount,
  generateDailyReports,
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
```

`runMarketSentinelOnce` 只编排小脑单次检查，不请求网络、不读写文件、不调用 LLM，也不触发 broker。

`generateReport` / `generateDailyReports` 通过注入的 `BrainProvider` 和 `ReportWriter` 编排报告生成。当前集成测试使用 `MockBrainProvider` 和 `ReportsMemoryStore`，输出写入 `memory/reports/YYYY-MM-DD/{reportType}.json`。

## 禁止

- 不直接写文件。
- 不直接请求网络。
- 不直接调用模型 SDK。
- 不直接调用券商 SDK。
