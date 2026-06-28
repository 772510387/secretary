# Proposal: 飞书问责反馈事实包与审计回答链路

## Metadata

- proposal_id: `2026-06-28-224040-feedback-audit-feishu-feedback-factpack-f3a64d30`
- slug: `feishu-feedback-factpack`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28T22:40:40+08:00`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-224040-feedback-audit-feishu-feedback-factpack-f3a64d30.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让飞书里的问责追问先读取可审计事实包，再由模型基于证据解释“看没看、漏在哪、为什么、怎么补”。

## Final Decisions

- 问责类反馈必须先由确定性代码生成只读事实包，覆盖观察池快照、计划、提案、成交、报告和证据缺口。
- 飞书 agentic 对话暴露只读工具，例如 `get_feedback_audit`，模型回答前必须先取事实包。
- LLM 可负责自然语言解释、复盘表达和补救建议，不允许直接改账户、改规则、下单或补写历史证据。

## Explicit Non Goals

- 不让模型直接判断“是否看过 100 池”，也不让模型把提案夸大成成交。
- 不修改账户、持仓、风控规则、交易规则或长期记忆最终版本。
- 不伪造缺失的历史 watchlist、计划、提案、报告或成交证据。

## User Value

- 用户在飞书追问“上周为什么只操作两支、其他股票你确定看了吗”时，系统能给出日期、证据路径、覆盖缺口和责任边界。
- 后续复盘不再停留在泛泛道歉，而是能区分看过、计划过、提案过、成交过和没有证据证明看过。

## Scope

### In Scope

- 构建或校准只读 `ProblemFeedbackFactPack` 用例。
- 对接飞书 agent 工具链，让问责/反馈类问题优先调用事实包工具。
- 统计指定日期范围内的 100 池覆盖、计划、提案、成交、报告和缺失证据。
- 将事实包作为模型回答上下文，生成基于证据的原因解释、影响评估和补救方案。
- 补齐单元测试、临时 memory 集成测试和飞书手动验证说明。

### Out Of Scope

- 自动修改规则、账户、持仓、订单、提案状态或长期记忆最终版本。
- 构建新的 UI 页面、飞书卡片复杂交互或移动端展示。
- 对历史缺失数据做事后补录；缺失只能明确标记为“未找到证据”。

## Module Mapping

### Existing Modules Likely Affected

- `src/app`：承载事实包 use case 和 agent 工具编排，不放底层确定性交易规则。
- `src/app/brain-agent-tools.ts`：暴露 `get_feedback_audit` 只读工具 schema、说明和执行入口。
- `src/app/build-paper-agent-deps.ts`：把事实包工具接入模拟盘飞书 agent 依赖。
- `src/app/run-brain-agent.ts`：更新系统提示和路由策略，要求问责问题先取事实包。
- `src/domain/memory`：继续提供记忆读写边界和“模型不能直接覆盖长期记忆”的策略约束。
- `src/domain/audit`：定义工具调用、证据缺口、回答降级和飞书回复的审计事件结构。
- `src/infrastructure/storage`：读取 memory 文件、JSON/JSONL 和原子写入审计记录。
- `scripts/dev/feishu-bot.ts`：验证飞书入口是否复用 agent 工具链。
- `memory/market/pool-snapshots`：作为 100 池覆盖证据来源。
- `memory/plans`：作为每日计划证据来源。
- `memory/proposals`：作为候选或交易提案证据来源。
- `memory/portfolio/trades.jsonl`：作为模拟成交证据来源。
- `memory/reports`：作为报告和复盘证据来源。

### New Modules Or Files Proposed

- `src/app/problem-feedback.ts`：生成只读问题反馈事实包；若已存在，则作为校准和补强目标。
- `tests/unit/problem-feedback.test.ts`：覆盖日期范围、100 池覆盖、计划/提案/成交/报告统计和缺失证据。
- `tests/integration/problem-feedback-agent.test.ts`：用临时 memory 和 mock agent 验证飞书问责链路。
- `memory/logs/audit-YYYY-MM-DD.jsonl`：可选记录工具调用摘要和降级原因，不保存密钥或完整隐私文本。

### README Files To Check Or Update

- `src/app/README.md`：说明事实包 use case 的输入、输出、只读边界和飞书用途。
- `src/domain/memory/README.md`：确认模型不能直接覆盖长期记忆，事实包只读。
- `src/domain/audit/README.md`：确认问责事实包和飞书回答需要的审计事件。
- `tests/unit/README.md`：补充问题反馈事实包和 agent 工具测试覆盖。
- `docs/ops/feishu-bot.md`：补充飞书问责问题的手动验证方式。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 日期范围、100 池是否完整、提案与成交区分、证据路径、缺失状态和降级原因由代码计算。
- llm_authority: LLM 可负责把事实包组织成解释、复盘、承认遗漏和补救方案。
- infrastructure_boundary: 文件系统、飞书 SDK、模型 SDK 和审计落盘由 infrastructure 或 scripts/runtime 装配层处理。
- domain_boundary: 事实包属于 app 用例编排；domain 不联网、不读写文件、不调用模型、不接 broker。
- auditability: 每个“看过/没证据/提案过/成交过”的结论都必须能追溯到 memory 路径或缺失记录。
- simulation_default: 运行模式由配置决定；事实包服务模型强判断和后续执行提案，执行侧由适配器、权限和审计链路承接。

## Core Domain Rules

必须由确定性代码实现的规则：

- 相对日期如“上周”“最近几天”必须按 `Asia/Shanghai` 本地时间换算。
- 只有存在对应日期的观察池快照且最大池规模达到目标值，才可判定该日有完整 100 池覆盖证据。
- `memory/proposals` 只能统计为候选或提案，不能统计为成交。
- 成交只能来自模拟盘交易账本，例如 `memory/portfolio/trades.jsonl`。
- 缺失快照、缺失计划、缺失提案、缺失成交或缺失报告必须显式输出为“未找到证据”。
- 事实包工具只读，不写账户、不写规则、不下单、不修改提案状态。

## Data Flow

### Inputs

- 飞书用户问责或反馈原文。
- 可选日期范围：`from` / `to`，或相对时间表达。
- `memory/market/pool-snapshots/*.jsonl`。
- `memory/plans/<date>/*`。
- `memory/proposals/<date>/*`。
- `memory/portfolio/trades.jsonl`。
- `memory/reports/<date>/*`。

### Outputs

- `ProblemFeedbackFactPack`：日期范围、每日覆盖状态、计划数、提案数、成交数、报告数、标的列表、证据路径、缺口和回答指引。
- 飞书自然语言回答：基于事实包解释事实、遗漏、影响和补救动作。
- 可选审计摘要：工具调用时间、日期范围、命中证据数量、缺口数量和降级状态。

### State To Persist

- 默认不持久化事实包正文，避免把用户问责原文和长文本重复写入 memory。
- 可选持久化 metadata-only 审计记录：requestId、dateRange、evidenceCounts、gapCounts、result、errorSummary。

### Audit Records

- `feedback_factpack_requested`：用户请求、日期范围、触发入口和调用者。
- `feedback_factpack_built`：证据命中数量、缺失数量、降级 notes 和结果状态。
- `feedback_answer_generated`：模型是否被调用、输入事实包摘要、输出摘要和禁止动作。
- `feedback_factpack_failed`：非法日期、文件读取失败、解析失败或范围过大。

## Configuration

### Required Config

- `FEEDBACK_AUDIT_LOOKBACK_DAYS`：默认回看天数，默认 `7`，可选。
- `FEEDBACK_AUDIT_MAX_RANGE_DAYS`：单次最大检查日期跨度，默认 `31`，可选。
- `FEEDBACK_AUDIT_FULL_POOL_TARGET`：完整观察池目标规模，默认 `100`，可选。
- `FEEDBACK_AUDIT_ENABLE_FEISHU_TOOL`：是否在飞书 agent 中启用该只读工具，默认 `true`，可选。

### Secrets

- 是否需要密钥：事实包本身不需要；飞书入口和真实模型 provider 需要。
- 密钥来源：环境变量、本机密钥管理或部署平台 secret manager。
- 禁止写入仓库的内容：飞书 app secret、模型 API key、broker 凭据、真实账户号、token、cookie、完整用户隐私原文和 `.env`。

## Error Handling

- 日期范围非法时返回明确错误或使用默认回看窗口，不让模型猜日期。
- 某个 memory 文件不存在时不中断事实包构建，将该证据标记为缺失。
- 单行 JSON/JSONL 解析失败时跳过该行，并在 notes 中记录解析降级。
- 读取失败必须返回 `ok:false` 或带降级 notes，不能编造“已覆盖”。
- 飞书或模型失败时保留事实包摘要和本地错误审计，不执行任何交易副作用。

## Tests Required

### Unit Tests

- 完整 100 池快照判定为 `full` 覆盖。
- 快照不足 100 或缺失时输出明确缺口。
- 提案和成交分开统计，proposal 不得算 trade。
- 日期范围、默认回看、最大跨度截断和 `Asia/Shanghai` 换算正确。
- 工具调用只读，不产生账户、规则、订单或 memory 写入副作用。

### Integration Tests

- 用临时 memory 目录组合模拟 pool snapshots、plans、proposals、trades 和 reports。
- mock 飞书/agent 路径验证问责类问题会调用 `get_feedback_audit`。
- 模型 provider 失败时仍能返回事实包降级说明。

### Manual Verification

- 在飞书发送：“上周为什么只操作了两支线，其他的股你确定你有看吗？”
- 回答必须包含日期范围、100 池覆盖证据、缺失日期、提案/成交区分和补救计划。
- 删除某日快照后再次提问，回答必须明确“未找到完整 100 池覆盖证据”。

## Acceptance Criteria

- 飞书问责类问题不再只依赖泛 memory search，而是先取结构化事实包。
- 回答能明确区分“观察池覆盖”“计划/候选”“交易提案”“模拟成交”“报告复盘”。
- 缺失证据被明确承认，不被模型补全或粉饰。
- 全链路按配置运行，先取结构化事实包，再由模型给出判断、解释和补救/执行提案。
- 相关 unit 和 integration 测试通过，README 说明保持准确。

## Dependencies

### Depends On Other Proposals

- `none`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

none

## Suggested Implementation Order

1. 盘点现有 `BuildProblemFeedbackFactPackUseCase`、飞书工具链和测试，确认已实现与缺口。
2. 完善事实包结构、日期范围解析、证据读取、缺失标记和只读约束。
3. 接入或校准飞书 agent 工具，要求问责类问题先调用事实包。
4. 补齐 unit、integration 和手动飞书验证。
5. 更新 app、memory、audit、tests 和飞书运维 README。

## Notes For Coding Agent

后续实现保持“事实包接地 + 模型强判断”的口径。模型可以基于证据判断覆盖质量、责任原因和补救动作，但不能把提案当成交或补造历史数据；所有网络、文件、飞书、模型调用都通过 app/infrastructure/runtime 边界装配。

