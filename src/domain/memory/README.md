# Memory Domain

负责长期记忆的结构、读写策略和写入提案。

## 需要实现

- `MemoryDocument`：记忆文档元数据。
- `MemoryQuery`：读取请求。
- `MemoryReadPolicy`：不同任务允许读取哪些目录。
- `MemoryWriteProposal`：大脑写入提案。
- `MemoryWritePolicy`：已实现，区分自动允许、必须人工确认提案和拒绝写入。
- `TradeIntentReviewProposal`：已实现，把研究报告中的交易意图草案转成待人工确认提案。
- `MemoryWriteReviewProposal`：已实现，把需要人工确认的记忆写入请求转成待审核提案。
- `MemoryIndex`：已实现第一阶段 schema，基础设施层 `MemoryRegistry` 可按目录建立轻量文件索引。
- `MemoryRetentionPolicy`：归档和保留策略。

## 当前接口

```ts
import {
  evaluateMemoryWritePolicy,
  createMemoryWriteReviewProposal,
  createTradeIntentReviewProposalsFromResearchReport,
  memorySearchQuerySchema,
  memoryWriteRequestSchema,
  tradeIntentReviewProposalSchema,
} from "./src/domain/memory/index.js";

const proposals = createTradeIntentReviewProposalsFromResearchReport(researchReport);
const checked = proposals.map((proposal) => tradeIntentReviewProposalSchema.parse(proposal));

const request = memoryWriteRequestSchema.parse(input);
const decision = evaluateMemoryWritePolicy(request);
const reviewProposal =
  decision.status === "proposal_required"
    ? createMemoryWriteReviewProposal(request, decision)
    : undefined;

const searchQuery = memorySearchQuerySchema.parse({
  query: "止损",
  category: "research",
  from: "2026-06-01T00:00:00.000Z",
  to: "2026-06-30T23:59:59.999Z",
  limit: 5,
});
```

`createTradeIntentReviewProposalsFromResearchReport()` 只做领域转换：

- 输入必须是合法 `ResearchReport`。
- 每个 `TradeIntentDraft` 生成一个 `trade_intent_review` 提案。
- 默认状态是 `pending_review`。
- 提案固定 `executable=false`、`brokerSubmissionAllowed=false`、`accountWriteAllowed=false`。
- 不生成 `TradeIntent`，不生成 `Order`，不接 broker。

`evaluateMemoryWritePolicy()` 只做领域判断：

- 普通复盘、经验总结、题材理解、错误模式、非敏感日志摘要可以自动允许，但仍要求审计。
- 软阈值小幅调整只有在提供范围上限/下限、证据引用且不削弱硬规则时才允许自动应用。
- 主板限制、T+1、100 股、8% 止损、单股 40%、实盘开关和 broker 边界必须进入人工提案。
- 删除审计、写入密钥、绕过风控、写账户/订单、把模型输出变成直接订单会被拒绝。
- 领域层不写文件；落盘必须由 infrastructure storage 处理。

`createMemoryWriteReviewProposal()` 只把 `proposal_required` 的决策转换为 `memory_write_review` 提案：

- 默认状态是 `pending_review`。
- 固定 `executable=false`、`brokerSubmissionAllowed=false`、`accountWriteAllowed=false`、`liveTradingAllowed=false`。
- 提案不是最终写入动作，不会改规则、账户或 broker。

`MemoryRegistry` 由基础设施层实现，领域层只定义结构：

- `MemoryDocument`：可检索文档元数据。
- `MemorySearchQuery` / `MemorySearchResult`：关键词检索输入输出。
- `MemoryRecentQuery` / `MemoryRecentItem`：最近研究报告和复盘报告元数据。

第一阶段只支持文件系统、Markdown、JSON、JSONL 和文本文件；不引入向量数据库，不调用 LLM。
`MemoryRegistryQuery`、`MemorySearchQuery` 和 `MemoryRecentQuery` 支持 `from`、`to`、`limit`、`category`/`categories`。搜索结果会返回 `path`、`summary`、`updatedAt` 和脱敏后的 metadata；最近报告只返回标准化复盘 metadata，不返回 `contentMarkdown` 或完整研究正文。
`memory/market/watchlists` 属于 R5 自选池专用存储，由 `WatchlistMemoryStore` 直接读写，当前不进入通用 `MemoryRegistry` 索引，避免把自选池当成可执行交易指令。

## 输入

- 用户任务。
- 小脑事件。
- 研究报告。
- 复盘结果。
- 记忆写入提案。

## 输出

- 上下文包。
- 写入提案。
- 已批准写入。
- 审计事件。

## 关键规则

- 模型不能直接覆盖长期记忆。
- 账户和规则类记忆默认只允许代码写入。
- 经验、观察、复盘可以由模型提案，经过策略批准后写入。

## 验收

- 每次写入有来源、时间、原因。
- 可追踪谁触发、为什么写。
- 可区分事实、推断、计划和反思。
