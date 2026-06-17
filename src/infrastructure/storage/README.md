# Storage Infrastructure

负责本地 JSON、备份、原子写入和未来 SQLite。

## 需要实现

- `JsonStore<T>`：已实现，负责读取、校验、写入和 update。
- `AtomicFileWriter`：已实现，使用同目录临时文件 + rename。
- `BackupManager`：已实现，覆盖前备份到同级 `.backups`。
- `ReportsMemoryStore`：已实现，负责报告写入 `memory/reports`。
- `ResearchMemoryStore`：已实现，负责研究报告写入 `memory/research`。
- `ProposalMemoryStore`：已实现，负责人工确认提案写入 `memory/proposals`。
- `MemoryRegistry`：已实现，负责按类别列出记忆文档、关键词搜索和最近研究/报告元数据读取。
- `RuntimeHealthStore`：已实现，负责写入 runtime health snapshot 和 heartbeat metadata。
- `WatchlistMemoryStore`：已实现，负责写入 `memory/market/watchlists` 的今日关注、长期自选和潜力股池。
- `LiveTradingSafetyStore`：已实现，负责写入未来 live gate 的账户 allowlist 和 kill switch 状态，并追加 metadata-only 审计。
- `SchemaRegistry`：加载 `data/schemas`。
- `MigrationRunner`：未来 schema 升级。

## 写入要求

- 写入前校验 schema。
- 写入前备份。
- 写入失败不破坏原文件。
- 重要写入生成审计事件。

## 当前接口

```ts
import { z } from "zod";
import {
  JsonStore,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";

const accountSchema = z.object({
  accountId: z.string(),
  cash: z.number().nonnegative(),
});

const store = new JsonStore({
  filePath: "memory/portfolio/account.json",
  schema: accountSchema,
});

store.write({ accountId: "paper", cash: 20000 });
const account = store.read();
```

`JsonStore.write()` 会先进行 schema 校验。只有校验通过才会调用 `AtomicFileWriter`，因此非法数据不会触发备份，也不会破坏原文件。

`AtomicFileWriter` 默认行为：

- 自动创建父目录。
- 如果目标文件存在，先复制到 `.backups`。
- 写入同目录临时文件。
- 使用 `rename` 替换目标文件。
- 出错时删除临时文件并抛出 `StorageError`。

`initializePaperAccountMemory()` 已用于 T004 初始化模拟账户：

- 写入 `memory/portfolio/account.json`。
- 写入 `memory/portfolio/positions.json`。
- 创建空 `memory/portfolio/trades.jsonl`。
- 追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 默认 dry-run，不覆盖已有账户文件。
- 只有 `reset=true` 才允许覆盖并创建备份。

`ReportsMemoryStore.writeReport()` 已用于 T013 报告生成：

- 写入 `memory/reports/YYYY-MM-DD/{reportType}.json`。
- 写入前使用 `generatedReportSchema` 校验。
- 重复写入同一报告时会通过 `AtomicFileWriter` 创建备份。
- 报告建议只允许非执行草案，不直接进入 broker。

`ResearchMemoryStore.writeReport()` 已用于 T014 研究报告落盘：

- 写入 `memory/research/YYYY-MM-DD/{reportId}.json`。
- 写入前使用 `researchReportSchema` 校验。
- 重复写入同一研究报告时会通过 `AtomicFileWriter` 创建备份。
- 研究报告里的交易建议只能是 `TradeIntentDraft`，不能直接执行。
- 成功写入后追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 审计日志只记录 reportId、taskId、provider、symbol、degraded、交易草案数量、人工复核标记和文件路径等元数据。
- 审计日志不记录完整 `summary`、`findings`、`bullBearViews`、`riskFactors` 或交易草案 `rationale`。
- 如果研究报告 schema 校验失败，不会写入研究报告，也不会追加成功审计事件。

`ProposalMemoryStore.writeProposal()` 已用于 P4-1 人工确认提案落盘：

- 写入 `memory/proposals/YYYY-MM-DD/{proposalId}.json`。
- 写入前使用 `reviewProposalSchema` 校验。
- 重复写入同一提案时会通过 `AtomicFileWriter` 创建备份。
- 成功写入后追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 审计日志只记录 proposalId、来源报告、来源 draft、标的、方向、状态、执行保护标记和文件路径等元数据。
- 审计日志不记录完整 `rationale` 或 `reviewReason`。
- `memory_write_review` 审计只记录 requestId、writeType、operation、targetCategory、targetPath、策略决策和执行保护标记，不记录完整写入正文。
- 如果提案 schema 校验失败，不会写入提案，也不会追加成功审计事件。

`MemoryRegistry` 已用于 U3 记忆检索：

- `listDocuments()` 按 `rules`、`research`、`reports`、`proposals`、`logs` 列出 Markdown、JSON、JSONL 和文本文件，支持 `category`/`categories`、`from`、`to` 和 `limit`。
- `search()` 做轻量关键词检索，支持时间范围过滤，返回 `path`、`summary`、`updatedAt`、metadata、文件元数据、命中次数和脱敏短片段。
- `recent()` 返回最近 `research` 或 `reports` 的元数据，支持 `from`、`to` 和 `limit`，不返回完整研究正文或报告正文。
- `reports` 最近读取会抽取标准化复盘 metadata：`period`、`symbols`、`marketSummary`、`decisionSummary`、`riskNotes`、`linkedAuditIds`。
- 不索引 `portfolio/`、`config/`、`secrets/`、`broker/`、`orders/` 等高风险目录。
- 不引入向量数据库，不调用 LLM，不联网。

`RuntimeHealthStore` 已用于 R1-2 运行态健康状态：

- 写入 `memory/logs/runtime-health.json`。
- 追加 `memory/logs/heartbeat-YYYY-MM-DD.jsonl`。
- 写入前使用 Zod schema 校验。
- metadata 会脱敏 `apiKey`、`token`、`password`、`secret`、`account` 等字段，并截断长文本。
- 错误只记录 `errorType`、脱敏 `message` 和 `occurredAt`，不记录 stack、密钥、账号或完整研究正文。
- 当前由 `MarketSentinelDaemon` 在启动、重复启动、task 成功、task 失败和停止时调用。

`WatchlistMemoryStore` 已用于 R5-1 自选池：

- 写入 `memory/market/watchlists/{category}.json`，category 为 `watchlist_today`、`watchlist_long_term` 或 `potential_stocks`。
- 支持人工 seed/import，按 `market:symbol` 合并同一标的，后导入覆盖旧条目。
- 成功写入后追加 `memory/logs/audit-YYYY-MM-DD.jsonl`，审计只记录 category、entryCount、symbols、优先级统计和文件路径等元数据。
- 不使用 web search，不调用 LLM，不接 broker，不写账户。

`LiveTradingSafetyStore` 已用于 R9 非交易性实盘安全底座：

- 写入 `memory/broker/live-account-allowlist.json`。
- 写入 `memory/risk/kill-switch.json`。
- 成功写入后追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- allowlist 审计只记录 entry 数量、enabled 数量、brokerProvider 和脱敏账户标识。
- kill switch 审计只记录 ruleId、scope、mode、脱敏账户、标的和文件路径，不记录完整 reason 或真实账号。
- 缺 allowlist 时 `LiveTradingGate` 默认拒绝。
- 不接真实 broker，不下单，不写 portfolio 订单或交易流水。

## 首批存储对象

- 账户。
- 持仓。
- 交易流水。
- 规则配置。
- 研究报告。
- 记忆提案。
- 审计日志。
- runtime health 和 heartbeat。
- live account allowlist 和 kill switch。

## 后续

T003 会在 `data/schemas` 和领域模块里定义账户、持仓、交易流水、审计事件等业务 schema。当前 T002 只提供通用存储能力。
