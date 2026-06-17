# GeminiProvider 结构化输出兼容性评估

## 背景

R8-2 要评估 Gemini structured output 是否适合接入当前 `BrainProvider`。当前系统的硬边界是：模型不能拥有工具执行权限，输出必须先成为候选 `BrainOutput`，再通过本地 `validateBrainOutput()` 和任务级 Zod schema 校验。

参考资料：

- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/rate-limits

## 外部事实

截至 2026-06-16，Gemini API 文档说明可以通过 `response_format` 配置让模型按 JSON Schema 输出，并提供 Python/Pydantic、JavaScript/Zod 和 REST 示例。

Gemini structured output 支持的是 JSON Schema 子集，支持基础类型、对象、数组、必填字段和描述等结构。文档还说明 Gemini 3 系列可以把 structured output 与内置工具组合使用，但本项目不能给模型任何工具执行能力。

Gemini API 限流按项目评估，常见维度包括 RPM、输入 TPM 和 RPD，超过任一维度都会触发限流错误；不同模型和账号层级的限制不同。

## 决策

R8-2 当前只做评估，不实现 `GeminiProvider`。

原因：

- 当前 `BrainOutput` 使用 `jsonValueSchema` 承载开放结构，直接转换为 Gemini structured output 的严格 JSON Schema 需要额外收敛。
- Gemini structured output 的 schema 子集与 Zod 的全部能力并非一一对应，尤其是复杂 union、递归、passthrough 和开放 JSON 值。
- 项目已有 `DashScopeQwenProvider` 和 R8-1 `OpenAIProvider` 两个真实 provider 适配面，Gemini 可以等 schema 转换策略稳定后再实现。
- Gemini 的内置工具能力必须默认禁用，不能让模型拥有搜索、代码执行、函数调用或文件搜索执行权限。

## 兼容性结论

可兼容，但不应直接把完整 `brainOutputSchema` 原样交给 Gemini。

推荐未来实现策略：

- 请求 Gemini 只返回一个紧凑 JSON 对象，例如 `summary`、`structured`、`citations`、`confidence`、`proposals`。
- 对开放 `structured` 字段使用任务级窄 schema，而不是通用 `jsonValueSchema`。
- 对 `proposals` 保持 `requiresReview=true`，并在本地再次校验。
- 不传 Gemini tools，不启用内置 Google Search、URL Context、Code Execution 或 Function Calling。
- 最终输出仍必须调用 `validateBrainOutput(candidate, structuredOutputSchema)`。

## 错误、限流和费用

未来实现必须覆盖：

- 缺 key。
- 401/403。
- 429 和配额耗尽。
- 5xx。
- 超时。
- 空响应。
- 坏 JSON。
- Gemini schema 拒绝或输出不符合本地 Zod。

限流策略：

- provider 级并发上限。
- 每分钟请求数和 token 预算。
- 429 后指数退避和短期熔断。
- 失败时降级到 mock provider 或返回明确失败，不写成功报告。

## 测试策略

未来实现时：

- 默认使用 mock fetch，不联网。
- 不写 API key。
- 不接真实 Gemini SDK，除非有明确任务要求。
- 真实 smoke 必须显式环境变量，例如 `GEMINI_BRAIN_NETWORK=1` 和本机 `GEMINI_API_KEY`。

## 后续动作

- 暂缓 `GeminiProvider` 实现。
- 先为 `BrainOutput` 到 provider JSON Schema 的最小转换策略补设计。
- 等 OpenAIProvider 和 DashScopeQwenProvider 稳定后，再用 mock fetch 实现 Gemini 适配器。

## 实现更新（2026-06-16）

状态变更：`GeminiProvider` 已实现，本 ADR 从“暂缓”转为“已落地”。

实现要点（遵循上文兼容性结论）：

- `src/infrastructure/providers/gemini-provider.ts`：原生 `generateContent` REST 适配器，原生 `fetch` + 可注入 `fetchImpl`，**不引入 Google SDK**。
- 端点 `…/v1beta/models/{model}:generateContent`，key 走 `x-goog-api-key` 请求头，不放进 URL/query，避免泄漏到日志。
- `generationConfig.responseMimeType=application/json` 走 JSON 模式；只请求紧凑对象（summary/structured/citations/confidence/proposals）。
- 不传任何 Gemini tools，不启用内置 Search/URL Context/Code Execution/Function Calling。
- 输出仍调用 `validateBrainOutput(candidate, structuredOutputSchema)` 本地再校验，并断言 requestId/taskType/provider 一致。
- 错误覆盖：缺 key、400 API key invalid、401/403、429、5xx、超时、空响应、坏 JSON、`promptFeedback.blockReason` 拦截。
- 默认模型 `gemini-2.0-flash`。

主备策略：

- 新增 `FallbackBrainProvider`（`fallback-brain-provider.ts`）按顺序尝试主→备，主失败自动降级到备用 provider，全部失败抛聚合错误。
- 新增配置 `BRAIN_FALLBACK_PROVIDER`（`config.brain.fallbackProvider`）。`createBrainProvider` 在主备不同的时候返回 `FallbackBrainProvider`。
- 推荐配置：`BRAIN_PROVIDER=gemini` + `BRAIN_FALLBACK_PROVIDER=dashscope`。

限流/费用项（provider 级并发、token 预算、429 退避熔断）仍未实现，留待后续；当前主失败即降级到 fallback，fallback 再失败才报错。

测试：`tests/unit/gemini-provider.test.ts`、`tests/unit/fallback-brain-provider.test.ts`、`tests/unit/brain-provider-factory.test.ts`，全部 mock fetch，不联网、不写真实 key。真实 smoke 经 `npm run brain:smoke` 且需 `BRAIN_NETWORK_SMOKE=1`。
