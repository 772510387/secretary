# Research Domain

负责深度研究任务和研究报告协议。

## 需要实现

- `ResearchTask`：已实现，研究任务。
- `ResearchReport`：已实现，结构化研究报告。
- `ResearchFinding`：已实现，发现项。
- `BullBearView`：已实现，多空观点。
- `RiskFactor`：已实现，风险因素。
- `ResearchSource`：已实现，数据来源。
- `TradingAgentsResearchAdapterOutput`：已实现，TradingAgents-CN 适配输出。

## 当前接口

- `researchTaskSchema`：校验研究任务。
- `researchReportSchema`：校验研究报告。
- `tradeIntentDraftSchema`：校验研究建议草案。
- `validateResearchTask()`：输入任务校验。
- `validateResearchReport()`：输出报告校验。

`ResearchReport` 包含：

- 股票代码、市场、交易日、生成时间。
- `summary`、`conclusion`、`confidence`。
- `findings`：结构化发现。
- `bullBearViews`：多空观点。
- `riskFactors`：风险清单。
- `sources`：来源。
- `tradeIntentDrafts`：交易意图草案。
- `requiresHumanReview=true`。
- `degraded`：外部研究失败或超时时的降级标记。

## 输入

- 股票代码。
- 日期。
- 行情摘要。
- 账户上下文。
- 新闻和公告。
- 外部研究工具输出。

## 输出

- 研究结论。
- 多空观点。
- 风险清单。
- 操作建议草案。
- 是否需要进一步确认。

## 边界

研究报告不是订单。

任何买卖建议必须经过：

```text
ResearchReport -> TradeIntentDraft -> Risk/Policy -> Order
```

当前 `TradeIntentDraft` 固定：

- `source=research`
- `requiresReview=true`
- `executable=false`

研究适配器不得直接调用 broker，不得写账户。
