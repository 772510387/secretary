# BrainProvider 真实接入评估

## 背景

当前 `secretary` 已有 `BrainProvider` 抽象和 `MockBrainProvider`，报告生成默认可在不调用真实模型的情况下运行。P5-2 只评估真实 provider 接入顺序，不实现 SDK 调用，不写 API key。

候选 provider：

- OpenAI
- Gemini
- DashScope Qwen

本项目的硬边界：

- API key 只来自环境变量或本机密钥管理，不进入仓库。
- 模型不持有可执行工具。
- `ToolPermission.canExecute` 固定为 `false`。
- 输出必须经过 `brainOutputSchema` 和任务级 structured schema 校验。
- 模型输出不是订单，不能直接进入 broker。

## 外部事实

调研日期：2026-06-14。

- OpenAI 当前建议复杂生产工作流使用 Responses API；官方 latest-model 文档描述 GPT-5.5 适合复杂生产、工具型 agent、长上下文和结构化工作流，并建议使用 Responses API、reasoning effort、structured outputs、prompt caching 等能力。
- OpenAI Structured Outputs 支持按 JSON Schema 约束输出，目标是减少缺字段、枚举幻觉等格式错误。
- Gemini structured output 支持 JSON Schema 子集，且官方说明过大或过深 schema 可能被拒绝。
- DashScope 百炼支持 OpenAI 兼容 Chat Completions、OpenAI 兼容 Responses、Anthropic 兼容 Messages 和 DashScope 原生 API；结构化输出当前以 JSON Mode 为主，需要设置 `response_format={"type":"json_object"}` 且 prompt 中包含 JSON 关键词。
- DashScope 限流按主账号维度计算，涉及 RPM、TPM、RPS、TPS 和突发增长限制。

参考：

- https://developers.openai.com/api/docs/guides/latest-model
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/api/docs/guides/cost-optimization
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/troubleshooting
- https://help.aliyun.com/zh/model-studio/qwen-api-reference/
- https://help.aliyun.com/zh/model-studio/qwen-structured-output
- https://help.aliyun.com/zh/model-studio/rate-limit
- https://help.aliyun.com/zh/model-studio/rate-limiting-best-practices

## 评估结论

首个真实 provider 建议实现顺序：

1. `DashScopeQwenProvider`
2. `OpenAIProvider`
3. `GeminiProvider`

状态更新：截至 2026-06-16，`DashScopeQwenProvider` 和 `OpenAIProvider` 已实现；`GeminiProvider` 已完成 structured output 兼容性评估，暂缓实现，详见 `2026-06-16-gemini-provider-structured-output-evaluation.md`。

理由：

- 本项目面向 A 股和中文研究，DashScope Qwen 在中文、本地化部署和国内网络可用性上更贴近默认场景。
- 当前配置已经有 `DEFAULT_DASHSCOPE_BASE_URL` 和 `brain.dashscope` 配置槽位，接入成本最低。
- DashScope 提供 OpenAI 兼容接口，便于先实现一个窄适配器，不引入大 SDK 面。
- OpenAI 作为质量基准和复杂推理增强 provider 保留第二优先级，尤其适合长上下文、复杂复盘和严格结构化输出场景。
- Gemini 可以作为后续多云备选，但其 structured output 是 JSON Schema 子集，接入前需要额外评估当前 `brainOutputSchema` 和报告 schema 是否需要简化。

如果部署环境稳定可访问 OpenAI，且优先目标是最高质量和更强 schema 约束，则可以把 `OpenAIProvider` 提到第一优先级。但默认工程推进按 DashScope 先行更务实。

## 统一接入协议

所有真实 provider 必须实现现有接口：

```ts
interface BrainProvider {
  readonly providerName: "mock" | "openai" | "gemini" | "dashscope";
  generate(input: BrainInput, options?: BrainGenerateOptions): Promise<BrainOutput>;
}
```

输入处理：

- 先用 `brainInputSchema.parse()` 校验。
- prompt 只能包含任务描述、上下文摘要和输出要求。
- 不注入交易执行工具。
- 不把 API key、账号、真实 broker 参数写入 prompt。
- `toolPermissions` 只允许 `read_only` 或 `propose_only`，且 `canExecute=false`。

输出处理：

- provider 原始响应先转成候选 `BrainOutput`。
- 必须调用 `validateBrainOutput(candidate, structuredOutputSchema)`。
- 结构化失败时抛 `BrainProviderError`，不得落盘为成功报告。
- 可以保存脱敏 debug 元数据，但不得污染领域层。

## 结构化输出策略

统一策略：

- OpenAI：R8-1 当前采用官方 Chat Completions + JSON Mode，并通过本地 `validateBrainOutput()` 做最终校验；后续如要迁移 Responses API，需要单独评估请求体、schema 表达和兼容测试。
- DashScope：第一阶段使用 OpenAI 兼容 Chat Completions + JSON Mode；后续再评估 OpenAI 兼容 Responses。
- Gemini：使用 structured output 时只传递其支持的 JSON Schema 子集；复杂 schema 先在本地转换或拆分。

无论 provider 是否声称支持结构化输出，最终都必须通过本地 Zod schema。

## 错误处理

统一错误类型：

- `missing_api_key`
- `auth_failed`
- `rate_limited`
- `quota_exceeded`
- `timeout`
- `server_error`
- `content_blocked`
- `schema_validation_failed`
- `empty_response`
- `unsupported_model`

处理规则：

- 缺 key：启动或调用前抛明确错误，不读取 `.env` 以外的隐式位置。
- 401/403：标记认证失败，不重试。
- 429：尊重 provider 响应头或错误信息，指数退避，最多重试小次数。
- 5xx/503：可短重试，但不得无限重试。
- 超时：AbortController 或等价机制取消请求。
- 内容安全阻断：返回明确错误，不把阻断内容当作报告。
- schema 失败：不得写报告；测试必须覆盖坏结构不落盘。

## 限流和并发

第一阶段只做本地限流：

- provider 级并发信号量。
- 每分钟请求数上限。
- 每分钟估算 token 上限。
- 针对 429 的退避和熔断。

后续如果进入常驻进程：

- scheduler 任务不能直接无限并发调用 provider。
- 盘中哨兵触发研究需要冷却和队列。
- 报告生成和研究总结应支持任务去重。

## 超时策略

默认建议：

- 快速报告：30 秒。
- 研究总结：60 秒。
- 长上下文复盘：120 秒。

超过超时时间：

- 取消 provider 请求。
- 记录失败审计或错误日志。
- 不写成功报告。
- 如业务允许，生成 degraded 结果必须明确 `degraded=true`，并标注来源为系统降级，不伪装成模型输出。

## 费用控制

第一阶段必须记录：

- provider。
- model。
- requestId。
- input token usage。
- output token usage。
- cached token usage（如 provider 返回）。
- estimatedCostCny 或 estimatedCostUsd（可选，价格表外置，不硬编码到业务逻辑）。

成本控制策略：

- 优先复用已有报告和 research memory。
- 缩短 prompt 动态上下文，稳定系统提示放前面。
- 低优先级任务使用较小模型。
- 夜间批量或非紧急任务可以未来评估 Batch/Flex/低优先级队列。
- 单日预算超过阈值时停止真实 provider，降级到 mock 或跳过非关键任务。

## 推荐落地步骤

1. 为 `BrainProviderError` 增加 provider、code、retryable、requestId 元数据。
2. 实现 `DashScopeQwenProvider`，只支持非流式 JSON Mode 和本地 Zod 校验。
3. 增加真实 provider 缺 key、429、超时、坏 JSON、坏 schema 的 mock fetch 测试。
4. 增加手动 smoke test，默认跳过，需要显式环境变量。
5. 已在 R8-1 实现 `OpenAIProvider`，作为质量基准和复杂任务选项。
6. 已在 R8-2 评估 `GeminiProvider`，重点处理 schema 子集和错误码映射；当前暂缓实现。

## 不做事项

- 不在本次评估中写 API key。
- 不实现真实 SDK 调用。
- 不允许模型拥有工具执行权限。
- 不允许模型直接写账户、规则、订单或 broker。
- 不把 provider 原始响应直接作为领域对象。
