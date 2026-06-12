# Brain Domain

负责大模型调用的抽象协议，不绑定具体供应商。

## 需要实现

- `BrainProvider`：已实现统一模型接口。
- `BrainInput`：已实现任务、上下文、工具约束。
- `BrainOutput`：已实现结构化回答、引用、置信度、提案。
- `BrainTaskType`：已实现盘前、复盘、新闻解释、交易建议、记忆提案等任务类型。
- `ToolPermission`：已实现模型可见工具边界，当前禁止执行权限。
- `StructuredOutputValidator`：已实现模型输出校验。

## 当前接口

- `brainInputSchema`：校验大脑输入。
- `brainOutputSchema`：校验大脑输出。
- `BrainProvider`：统一 provider 接口。
- `validateBrainInput()`：输入校验。
- `validateBrainOutput()`：输出校验，可选传入结构化输出 schema。
- `createStructuredOutputValidator()`：为具体报告或研究结果创建结构化校验器。

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

## Provider

首批实现：

- `MockBrainProvider`：已实现，不调用真实 API。
- `OpenAIProvider`：待实现。
- `GeminiProvider`：待实现。
- `DashScopeQwenProvider`：待实现，使用 OpenAI-compatible 地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

## 输出要求

- 重要任务尽量返回 JSON。
- 自然语言报告可以附带结构化摘要。
- 交易建议必须落为 `TradeIntentDraft`，不能直接执行。

## 禁止

- 不把 API key 写入 prompt。
- 不允许模型直接写账户、规则和订单。
- 不依赖模型遵守风控，风控必须由代码执行。
