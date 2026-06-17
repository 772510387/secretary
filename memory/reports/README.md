# Reports Memory

保存系统生成的报告。

## 报告类型

- 盘前计划。
- 午间复盘。
- 收盘复盘。
- 夜间新闻复核。
- 每日自省。
- 周报。
- 月报。
- 年报。

## 要求

- 报告必须包含生成时间。
- 报告要区分事实、推断和建议。
- 涉及交易建议时必须链接到对应 `TradeIntentDraft` 或研究报告。

## 当前写入格式

T013 已实现报告生成，默认路径：

```text
memory/reports/YYYY-MM-DD/{reportType}.json
```

当前支持：

- `pre_market_plan`
- `midday_review`
- `closing_review`
- `daily_reflection`

报告 JSON 包含：

- 生成时间和交易日。
- 账户摘要。
- 持仓摘要。
- 行情摘要。
- 风险摘要。
- 标准化复盘 metadata。
- 事实、推断和建议。
- `BrainOutput` 审计信息。
- `contentMarkdown` 人类可读版本。

所有建议当前都是 `executable=false`，不能直接下单。

## R7-2 复盘 metadata

日、周、月、年复盘报告的 metadata 采用统一字段，便于 `MemoryRegistry.recent()` 读取：

- `period`：`daily`、`weekly`、`monthly` 或 `yearly`。
- `symbols`：本报告涉及的 A 股标的代码数组。
- `marketSummary`：用于索引和列表展示的短摘要，不是完整报告正文。
- `decisionSummary`：本报告的非执行决策摘要。
- `riskNotes`：风险摘要数组。
- `linkedAuditIds`：关联审计事件 ID 数组。

当前 T013 生成的 `pre_market_plan`、`midday_review`、`closing_review` 和 `daily_reflection` 都写入 `period=daily`。未来周/月/年复盘可沿用同一 metadata 契约，但正文仍只放在 `contentMarkdown`，不得把完整正文塞进 metadata。
