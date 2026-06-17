# Memory

`memory` 是系统长期记忆，不是临时缓存。

## 目录

- `rules/`：交易规则、风控原则、系统边界。
- `portfolio/`：账户、持仓、交易流水、每日快照。
- `reports/`：盘前、午间、收盘、夜间、周/月/年报。
- `proposals/`：模型或系统提出的记忆写入和策略变更提案。
- `research/`：个股研究、主题研究、TradingAgents-CN 输出。
- `logs/`：审计日志和运行日志。
- `market/watchlists/`：今日关注、长期自选和潜力股池，由 storage 层原子写入。

## 写入原则

- 事实类写入由代码执行。
- 推断类写入需要标注来源和置信度。
- 规则类写入默认需要人工确认。
- 账户类写入必须由交易引擎或对账流程产生。

## 检索原则

`MemoryRegistry` 第一阶段只索引以下目录：

- `rules/`
- `research/`
- `reports/`
- `proposals/`
- `logs/`

检索返回：

- 文件类别。
- 文件路径。
- 文档标题。
- 更新时间。
- 可选时间范围过滤结果。
- 命中次数。
- 脱敏后的短片段。

最近记忆读取当前只支持：

- `research`：返回 reportId、title、symbol、provider、conclusion、confidence、degraded 等元数据。
- `reports`：返回 reportId、title、reportType、period、symbols、marketSummary、decisionSummary、riskNotes、linkedAuditIds、positionCount、quoteCount、liveTrading 等元数据。

`MemoryRegistry` 的 `listDocuments()`、`search()` 和 `recent()` 支持 `from`、`to`、`limit` 和 `category`/`categories` 过滤；时间过滤按文件 `updatedAt` 或最近条目的 `generatedAt`/`updatedAt` 判断。搜索结果直接返回 `path`、`summary`、`updatedAt` 和 `metadata`，同时保留完整 `document` 元数据。

检索不返回完整研究正文、完整报告正文、提案 rationale、密钥、token 或账户敏感正文。`portfolio/` 和 `market/watchlists/` 当前不进入通用记忆检索索引。第一阶段仍使用关键词和文件索引；向量语义检索仅有 ADR 评估，不引入大型向量库。

## 自选股池

R5-1 后，三类自选池落盘为：

- `memory/market/watchlists/watchlist_today.json`
- `memory/market/watchlists/watchlist_long_term.json`
- `memory/market/watchlists/potential_stocks.json`

第一阶段只支持人工 seed/import，不使用 web search 自动生成股票池。写入由 `WatchlistMemoryStore` 完成，并追加 metadata-only 审计；领域层只做 schema、归一化和去重。

## 禁止

- 禁止模型直接覆盖账户文件。
- 禁止把缓存当记忆。
- 禁止无来源、无时间、无原因的长期写入。
- 禁止把检索结果当作交易执行指令。
