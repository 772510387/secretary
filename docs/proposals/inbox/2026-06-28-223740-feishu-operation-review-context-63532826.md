# Proposal: 飞书操作复盘证据包

## Metadata

- proposal_id: `2026-06-28-223740-feishu-operation-review-context-63532826`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 22:37:40 +08:00`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-223740-feishu-operation-review-context-63532826.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让飞书里的操作复盘追问具备 `docs/display/operation-review.md` 所要求的证据深度：能基于成交、订单、提案、计划、快照、报告和审计线索回答“为什么买卖、卖了多少、时间戳、价格线、用户纠错”等问题。

## Final Decisions

- 采用 Operation Review Evidence Pack，把零散账本整理成模型可直接推理的结构化证据。
- 将操作复盘作为 agent 可调用工具暴露给飞书对话链路，工具名建议为 `get_operation_review`。
- 工具返回必须包含结构化事实、可直接引用的中文摘要和明确的数据缺口，不允许模型补齐缺失成本、盈亏或原始理由。
- 交易模式由运行配置决定；本方案聚焦操作复盘证据和飞书解释链路，不在文案中强行限定执行环境。
- 复盘解释由 LLM 完成，但成交事实、时间转换、订单/提案关联、账户快照差值必须由确定性代码生成。

## Explicit Non Goals

- 不让 LLM 修改账户、订单、风控规则、长期记忆最终版本或配置文件。
- 不重写现有 `TradingDayReviewUseCase`、`BuildProblemFeedbackFactPackUseCase` 或报告生成体系。

## User Value

- 用户在飞书里质疑“早上是不是卖了 200 股”“为什么 58.50 卖”“今天到底赚亏多少”时，系统能给出可审计、可纠错的回答。
- 模型回答复盘不再依赖记忆猜测，而是先取证据包，再解释证据和缺口。

## Scope

### In Scope

- 构建一个只读应用层证据包生成器，按交易日和可选股票代码汇总操作复盘上下文。
- 汇总 `memory/portfolio/trades.jsonl`、`orders.jsonl`、`daily-summary.jsonl`、快照、提案、计划、报告和审计日志。
- 在 agent tool 层暴露 `get_operation_review`，供飞书对话在操作复盘追问前调用。
- 更新 agent system prompt，要求遇到操作复盘和用户纠错时先查证据包。
- 增加单元测试覆盖证据拼接、北京时间转换、数据缺口、工具只读性和默认 wiring。

### Out Of Scope

- 修改领域层以直接读写文件系统。
- 用模型直接计算资金、成本、仓位、T+1 或风控结果。
- 建设前端页面或新的展示 UI。

## Module Mapping

### Existing Modules Likely Affected

- `src/app/brain-agent-tools.ts`：新增只读 agent 工具声明、参数校验和执行分发。
- `src/app/build-paper-agent-deps.ts`：默认 wiring 到当前 `memoryDir`，让飞书 agentic path 可直接生成操作复盘证据包。
- `src/app/run-brain-agent.ts`：更新系统提示，约束模型在操作复盘追问和用户纠错时先调用证据工具。
- `src/app/index.ts`：导出新 use case 和类型，供测试与其他会话复用。
- `scripts/dev/feishu-bot.ts`：通常无需直接改动；它已通过 agent tools 接入能力，后续只需确认工具集被注入。
- `tests/unit/brain-agent-tools.test.ts`：覆盖工具暴露、参数转发和只读返回。
- `tests/unit/build-paper-agent-deps.test.ts`：覆盖默认 wiring。
- `tests/unit/run-brain-agent.test.ts`：覆盖 prompt 指令。

### New Modules Or Files Proposed

- `src/app/operation-review-context.ts`：只读操作复盘证据包生成器。
- `tests/unit/operation-review-context.test.ts`：覆盖成交/订单/提案/计划/报告/审计拼接、北京时间转换和数据缺口。

### README Files To Check Or Update

- `src/app/README.md`：说明 Operation Review Context use case 的边界、输入和不写账户约束。
- `tests/unit/README.md`：补充该证据包的单元测试覆盖范围。
- `docs/ops/feishu-bot.md`：如后续需要向使用者说明飞书追问能力，可补充使用示例。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 成交筛选、订单/提案关联、北京时间转换、账户快照差值、数据缺口判定由 TypeScript 确定性代码完成。
- llm_authority: LLM 可负责基于证据解释原因、组织复盘语言、承认缺口和给出下一步建议。
- infrastructure_boundary: 文件系统读取保留在 app/use case 或其 wiring 内，不下沉到 domain；外部 provider 和 broker 不参与。
- domain_boundary: domain 继续只定义账户、交易、审计、记忆等 schema 和规则，不直接调用文件系统、网络或模型 SDK。
- auditability: 证据包必须引用成交、订单、提案、报告、审计等可追溯来源；缺少证据时显式报告。
- simulation_default: 工具只读且默认面向模拟盘账本；不引入真实交易参数和实盘写路径。

## Core Domain Rules

必须由确定性代码实现的规则：

- 成交事实以 `trades.jsonl` 为准，按 `tradeDate` 和可选 `symbol` 过滤，不允许模型凭记忆断言买卖。
- 订单关联优先使用 `orderId` 和 `intentId`，提案关联使用 `intent-${proposalId}` 映射，不允许模型模糊匹配后当作事实。
- 所有成交时间展示为北京时间，并保留原始 ISO 时间字段供审计。
- 账户级日收益只能来自已归档快照或 `daily-summary`，缺少前一交易日快照时必须标记无法计算。
- 单笔卖出已实现盈亏只有在成本批次可确认时才能计算；缺少成本归因时必须输出数据缺口。

## Data Flow

### Inputs

- 用户在飞书中的操作复盘追问。
- 可选参数：`tradingDate`、`symbol`、`includeRaw`。
- 本地 `memoryDir` 下的 portfolio、proposals、plans、reports、logs 等只读数据。

### Outputs

- 结构化 `OperationReviewContext`。
- 可直接给 LLM 引用的中文 `rendered` 摘要。
- `dataGaps`，列出无法断言或无法计算的部分。

### State To Persist

- 本方案本身不要求持久化新业务状态。
- 后续如果要缓存复盘结果，应作为派生报告写入 `memory/reviews` 或 `memory/reports`，并使用原子写入和审计策略。

### Audit Records

- 只读查询本身可不新增交易审计。
- 如未来将该工具暴露到 API/Webhook，应记录 read/access audit，包含调用者、日期范围、symbol、requestId 和脱敏后的参数。

## Configuration

### Required Config

- `MEMORY_DIR`：运行期记忆根目录；默认使用现有配置的 memory 目录；必需。
- `BRAIN_PROVIDER`：飞书 agentic 回答使用的模型 provider；默认按现有项目配置；本方案不新增要求。
- `FEISHU_ALLOWED_USERS`：飞书入口鉴权；沿用现有配置；本方案不改变。

### Secrets

- 是否需要密钥：不需要新增密钥。
- 密钥来源：如飞书和模型已有密钥，继续来自环境变量或本机密钥管理。
- 禁止写入仓库的内容：Feishu app secret、模型 API key、券商账号、真实交易参数、用户身份敏感信息。

## Error Handling

- 缺少某类文件时返回空集合和明确 `dataGaps`，不要抛出导致整轮飞书回答失败。
- JSONL 中单行损坏时跳过该行，但不影响其他有效证据读取；必要时在缺口或日志中标记。
- 参数非法时由工具参数 schema 拒绝，例如非 `YYYY-MM-DD` 日期或非 6 位股票代码。
- 未匹配到成交时明确回答“未找到成交流水，无法断言当日实际买卖”。
- 未匹配到原始提案或订单理由时，只解释成交事实，不补造当时判断。

## Tests Required

### Unit Tests

- `buildOperationReviewContext` 能拼接成交、订单、提案、计划、报告、审计和账户快照。
- 成交时间必须转换为北京时间。
- 卖出存在但成本批次缺失时必须输出数据缺口。
- 无成交、无订单、无快照时必须返回明确缺口而不是编造事实。
- `get_operation_review` 工具只读返回，不产生 `AgentToolEffect` mutation。
- 默认 `buildPaperAgentToolDeps` wiring 能在未传自定义实现时生成证据包。
- `buildDefaultSystemPrompt` 必须包含操作复盘和用户纠错先查证据的要求。

### Integration Tests

- 飞书/agentic bridge 在工具可用时能看到 `get_operation_review` spec。
- 模拟一次“今天为什么卖 000636”问答，验证模型先调用工具再回答。
- 模拟用户纠错“早上卖了 200 股”，验证回答根据工具证据修正旧说法。

### Manual Verification

- 用真实本地模拟盘 memory 询问“今天复盘”“早上是不是卖了 200 股”“58.50 怎么定”，确认回复引用成交时间、数量、价格和理由。
- 删除或隐藏某日快照后再询问，确认回复明确说缺少账户级盈亏证据。
- 确认工具调用不新增订单、不修改账户、不写规则。

## Acceptance Criteria

- 飞书中操作复盘追问能返回成交事实、北京时间、数量、价格、关联理由和数据缺口。
- 用户纠正事实时，系统先查 `get_operation_review`，并在证据支持时更正旧回答。
- 缺少成本批次、提案理由或快照时，回答明确说明无法断言的范围。
- 代码边界保持在 app/use case 和 agent tool wiring，不让 domain 直接访问文件系统或模型。
- `npm run typecheck` 和相关单元测试通过。
- 不引入真实交易能力、不新增密钥、不写账户或规则文件。

## Dependencies

### Depends On Other Proposals

- `none`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

- none

## Suggested Implementation Order

1. 新增只读 `buildOperationReviewContext`，先覆盖 memory 文件读取、schema 校验、成交/订单/提案关联和 `dataGaps`。
2. 在 `brain-agent-tools` 中新增 `get_operation_review` spec、参数 schema 和执行器，并接入 `buildPaperAgentToolDeps` 默认 wiring。
3. 更新 `run-brain-agent` prompt，要求复盘追问和用户纠错先调用证据包工具。
4. 补单元测试和必要文档，确认工具只读、不产生 mutation。
5. 手工通过飞书问答验证 `docs/display/operation-review.md` 中的典型追问深度。

## Notes For Coding Agent

后续实现必须保持模拟盘默认和只读证据链边界。LLM 可以解释证据，但不能生成成交事实、改账户、改规则或补造缺失盈亏。涉及金额、数量、盈亏、T+1、审计和记忆写入的任何扩展都必须补测试；真实交易相关能力保持关闭。

