# Research Memory

保存个股、行业、主题和深度研究结果。

## 来源

- 系统自有大脑。
- TradingAgents-CN 适配器。
- 用户手动导入。
- 公开数据源摘要。

## 要求

- 标注来源和生成时间。
- 标注事实和推断。
- 不把研究建议直接当作交易指令。
- 重要研究结果可链接到账户和交易复盘。

## 当前写入格式

T014 已实现 `ResearchMemoryStore`，默认路径：

```text
memory/research/YYYY-MM-DD/{reportId}.json
```

当前研究报告格式为 `ResearchReport`，包含：

- `summary`：研究摘要。
- `conclusion`：bullish、bearish、neutral、mixed。
- `findings`：结构化发现。
- `bullBearViews`：多空观点。
- `riskFactors`：风险因素。
- `sources`：来源。
- `tradeIntentDrafts`：非执行交易草案。
- `requiresHumanReview=true`。
- `degraded`：外部研究失败或超时时的降级标记。

研究报告可以由 `TradingAgentsCnAdapter` 产生，但适配器本身只返回报告，不自动写入、不下单。
