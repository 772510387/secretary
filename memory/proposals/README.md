# Proposals Memory

保存待人工确认的写入、规则变更、策略变更和交易意图评审提案。

## 当前模型

P4-1 已新增 `trade_intent_review` 提案模型，用于把 `ResearchReport.tradeIntentDrafts` 转成待人工确认项。
U4 允许 `ToolRuntime` 把 `propose_trade_intent` 请求转成同一种待人工确认提案，但仍不接 broker、不下单。
U2 已新增 `memory_write_review` 提案模型，用于把 `MemoryWritePolicy` 判定为 `proposal_required` 的记忆写入请求转成待人工确认项。

生成入口：

```ts
import {
  createMemoryWriteReviewProposal,
  createTradeIntentReviewProposalsFromResearchReport,
  evaluateMemoryWritePolicy,
} from "../../src/domain/memory/index.js";

const proposals = createTradeIntentReviewProposalsFromResearchReport(researchReport);
const decision = evaluateMemoryWritePolicy(memoryWriteRequest);
const memoryProposal =
  decision.status === "proposal_required"
    ? createMemoryWriteReviewProposal(memoryWriteRequest, decision)
    : undefined;
```

写入入口：

```ts
import { ProposalMemoryStore } from "../../src/infrastructure/storage/index.js";

const store = new ProposalMemoryStore({ memoryDir: "memory" });
store.writeProposal(proposals[0]);
```

## 提案类型

- `trade_intent_review`：研究报告中的交易意图草案，等待人工确认。
- `memory_write_review`：记忆写入请求，等待人工确认后才允许后续应用。
- 规则修改提案。
- 风控参数修改提案。
- 自选池调整提案。
- 交易计划提案。

## 状态

- `pending_review`：默认状态，等待人工确认。
- `approved`：人工已批准，但仍不能绕过后续策略、风控和审计。
- `rejected`：人工已拒绝。
- `applied`：后续流程已应用。当前 P4-1 不实现应用动作。

## 写入路径

`ProposalMemoryStore.writeProposal()` 写入：

- `memory/proposals/YYYY-MM-DD/{proposalId}.json`
- `memory/logs/audit-YYYY-MM-DD.jsonl`

审计日志只记录元数据，例如 proposalId、来源报告、来源 draft、标的、方向、状态、文件路径和执行保护标记；不记录完整 `rationale` 或 `reviewReason`。

`memory_write_review` 的审计日志只记录 requestId、writeType、operation、targetCategory、targetPath、策略决策和执行保护标记；不记录完整写入正文。

## 执行边界

`trade_intent_review` 新建时固定：

- `status=pending_review`
- `requiresManualReview=true`
- `executable=false`
- `brokerSubmissionAllowed=false`
- `accountWriteAllowed=false`
- `liveTradingAllowed=false`

这类提案不是订单，也不是 `TradeIntent`。P4-1 不接 `PaperBroker`，不下单，不写账户。

`memory_write_review` 新建时固定：

- `status=pending_review`
- `requiresManualReview=true`
- `executable=false`
- `brokerSubmissionAllowed=false`
- `accountWriteAllowed=false`
- `liveTradingAllowed=false`

这类提案不是最终记忆写入。没有后续人工确认和 storage 层写入流程时，不会修改 `memory/rules` 或其他最终记忆。

## 要求

- 提案必须有来源。
- 提案必须有原因。
- 提案必须说明影响范围。
- 写入提案必须写审计日志。
- 没有人工确认时不能进入订单链路。
