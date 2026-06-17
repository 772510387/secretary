# Brain Domain

负责大模型调用的抽象协议，不绑定具体供应商。

## 需要实现

- `BrainProvider`：已实现统一模型接口。
- `BrainInput`：已实现任务、上下文、工具约束。
- `BrainOutput`：已实现结构化回答、引用、置信度、提案。
- `BrainTaskType`：已实现盘前、复盘、新闻解释、交易建议、记忆提案等任务类型。
- `ToolPermission`：已实现模型可见工具边界，当前禁止执行权限。
- `ToolRuntime`：已实现结构化工具请求校验和计划生成，不执行工具。
- `StructuredOutputValidator`：已实现模型输出校验。

## 当前接口

- `brainInputSchema`：校验大脑输入。
- `brainOutputSchema`：校验大脑输出。
- `BrainProvider`：统一 provider 接口。
- `validateBrainInput()`：输入校验。
- `validateBrainOutput()`：输出校验，可选传入结构化输出 schema。
- `createStructuredOutputValidator()`：为具体报告或研究结果创建结构化校验器。
- `planToolRuntimeRequest()`：把大脑工具请求转换为只读计划、人工提案或拒绝结果。

`BrainOutput` 必须包含：

- `summary`：自然语言摘要。
- `structured`：JSON 结构化结果。
- `citations`：引用或上下文来源。
- `confidence`：0 到 1 的置信度。
- `proposals`：待审核提案。

安全约束：

- `ToolPermission.canExecute` 固定为 `false`。
- `trade_intent_draft` 和 `memory_write` 等提案必须是 `requiresReview=true`。
- 大脑输出不是订单，不能直接进入 broker。

## ToolRuntime

`ToolRuntime` is a validation and planning boundary for structured tool requests from the brain. It does not execute tools, does not call providers, does not call broker, and does not write accounts.

Current entry point:

```ts
import { planToolRuntimeRequest } from "./src/domain/brain/index.js";

const plan = planToolRuntimeRequest({
  requestId: "tool-request-001",
  requestedBy: { type: "brain", id: "mock-brain" },
  toolType: "search_memory",
  reason: "Need deterministic context.",
  payload: { query: "risk", categories: ["rules"], limit: 5 },
});
```

Allowed tool request types:

- `read_memory`
- `search_memory`
- `get_quote`
- `fetch_history`
- `propose_memory_write`
- `propose_trade_intent`

Forbidden tool request types are rejected before payload use:

- `execute_order`
- `write_account`
- `overwrite_rule`
- `enable_live_trading`
- `read_secret`

Planning rules:

- Read-only requests return `status=planned`, but still have `canExecute=false` and `executionAllowed=false`.
- Memory write requests must pass through `MemoryWritePolicy`; `proposal_required` decisions become `memory_write_review` proposals, and `reject` decisions stay rejected.
- Trade intent requests only become `trade_intent_review` proposals with `executable=false`, `brokerSubmissionAllowed=false`, `accountWriteAllowed=false`, and `liveTradingAllowed=false`.
- Rejected and planned requests include audit metadata; forbidden request audit does not include raw payload or secrets.

## Provider

首批实现：

- `MockBrainProvider`：已实现，不调用真实 API。
- `DashScopeQwenProvider`：已实现，使用 OpenAI-compatible Chat Completions 和 JSON Mode，输出必须经过本地 schema 校验。
- `OpenAIProvider`：待实现。
- `GeminiProvider`：待实现。

## 输出要求

- 重要任务尽量返回 JSON。
- 自然语言报告可以附带结构化摘要。
- 交易建议必须落为 `TradeIntentDraft`，不能直接执行。

## 禁止

- 不把 API key 写入 prompt。
- 不允许模型直接写账户、规则和订单。
- 不依赖模型遵守风控，风控必须由代码执行。
