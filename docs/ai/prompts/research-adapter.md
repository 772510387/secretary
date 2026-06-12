# Research Adapter Prompt

用于后续接入 TradingAgents-CN 或其他研究系统。

```text
请实现/调整 secretary 的研究适配器。

目标：
- 把外部研究系统输出转成 secretary 的 ResearchReport。
- 不允许研究系统直接发单或改账户。

请读取：
- AGENTS.md
- docs/architecture/decision-records/2026-06-12-secretary-core-with-research-adapter.md
- src/domain/research/README.md
- src/domain/brain/README.md
- src/infrastructure/providers/README.md

验收：
- 外部输出被结构化。
- 错误和超时有处理。
- 研究报告可写入 memory/research。
- 交易建议只生成 TradeIntentDraft。
```

