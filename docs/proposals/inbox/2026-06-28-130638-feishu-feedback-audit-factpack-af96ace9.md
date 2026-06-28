# Proposal: 飞书问责反馈事实包与深度回答链路

## Metadata

- proposal_id: `2026-06-28-130638-feishu-feedback-audit-factpack-af96ace9`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:06:38`
- suggested_output_path: `docs/proposals/inbox/2026-06-28-130638-feishu-feedback-audit-factpack-af96ace9.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让飞书里“你确定看了吗、为什么只操作几支、上周是否漏看”这类问责反馈，基于可审计事实包回答，而不是靠模型泛泛道歉。

## Final Decisions

- 先由确定性代码生成问题反馈事实包，检查指定日期范围内的 100 池覆盖、池快照、计划、提案、成交、报告证据。
- 飞书 agentic 对话新增只读工具，让模型在问责/反馈类问题上先取事实包，再组织自然语言解释和补救方案。
- 模型可以做原因解释、承认遗漏、复盘表达和补救建议，不允许直接改账户、改规则、下单或覆盖长期记忆。

## Explicit Non Goals


## User Value

- 用户在飞书追问“你有没有看其他股票”时，系统能给出日期、证据路径、覆盖缺口和明确责任，不再只输出空泛解释。
- 后续 Codex 会话可以从 proposal 直接理解方案边界，避免重复讨论“要不要实现成工具、模型能否直接判断”的问题。

## Scope

### In Scope

- 构建只读 `ProblemFeedbackFactPack` 用例。
- 对接飞书 agent 工具，例如 `get_feedback_audit`。
- 用事实包支持 `docs/display/problem-feedback.md` 期望的深度反馈：问题原因、遗漏证据、影响、补救计划。
- 为事实包和 agent 工具补单元测试。
- 更新目标模块 README，说明该链路的只读、模拟盘和审计边界。

### Out Of Scope

- 自动修改风控规则、交易规则、账户文件或长期记忆最终版本。
- 构建 UI 页面或改造飞书卡片展示。
- 对历史缺失数据做事后伪造补录；缺失只能如实标记为“未找到证据”。

## Module Mapping

### Existing Modules Likely Affected

- `src/app`：新增事实包 use case，并在 agent 编排中暴露只读工具。
- `src/app/brain-agent-tools.ts`：增加 `get_feedback_audit` 工具 schema、说明和执行入口。
- `src/app/build-paper-agent-deps.ts`：将事实包工具接入 live paper agent 工具依赖。
- `src/app/run-brain-agent.ts`：更新系统提示，要求问责类问题先调用事实包工具。
- `scripts/dev/feishu-bot.ts`：实际飞书入口已复用 agent 工具链，后续只需确认工具装配随 `buildLivePaperAgentTools` 生效。
- `memory/market/pool-snapshots`：作为不可变 100 池快照证据来源。
- `memory/plans`：作为每日计划/漏斗节点证据来源。
- `memory/proposals`：作为候选/交易提案证据来源。
- `memory/portfolio/trades.jsonl`：作为真实模拟成交证据来源。
- `memory/reports`：作为报告/复盘证据来源。

### New Modules Or Files Proposed

- `src/app/problem-feedback.ts`：生成只读问题反馈事实包。
- `tests/unit/problem-feedback.test.ts`：覆盖日期范围、100 池覆盖、提案与成交区分、证据路径。
- `docs/proposals/inbox/*feishu-feedback-audit-factpack*.md`：沉淀本方案，供后续 Codex 会话读取。

### README Files To Check Or Update

- `src/app/README.md`：说明 `BuildProblemFeedbackFactPackUseCase` 的输入、输出和禁止事项。
- `tests/unit/README.md`：补充问题反馈事实包与 agent 工具测试覆盖。
- `docs/ops/feishu-bot.md`：如飞书工具链启动方式或使用提示发生变化，需要补充验证说明。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 日期范围解析、100 池是否完整、计划/提案/成交/报告是否存在、证据路径、覆盖状态必须由代码计算。
- llm_authority: LLM 只做原因解释、复盘表达、承认遗漏、补救方案和自然语言报告。
- infrastructure_boundary: 文件系统读取、飞书 SDK、模型 SDK 仍在基础设施或脚本装配层；领域层不直接调用外部 SDK。
- domain_boundary: 事实包属于 app 编排用例；领域规则仍保留在 market、portfolio、memory、audit 等模块中。
- auditability: 每个结论必须能追溯到 `memory` 下的快照、计划、提案、成交或报告路径；缺失证据必须显式输出。
- simulation_default: 按运行配置读取交易记忆并服务模型判断，执行侧由适配器与审计链路承接。

## Core Domain Rules

必须由确定性代码实现的规则：

- 只有存在 `memory/market/pool-snapshots/YYYY-MM-DD.jsonl` 且最大池规模达到目标值时，才可判定该日期有完整 100 池覆盖证据。
- `memory/proposals` 中的 BUY/SELL 只能算候选或提案，不能算成交；成交只能来自 `memory/portfolio/trades.jsonl`。
- 日期范围、上周/最近几天等相对时间必须按 Asia/Shanghai 本地时间换算。
- 任何缺失快照、缺失计划、缺失成交、缺失报告都必须标记为“未找到证据”，不得由模型补全。
- 事实包只读，不修改账户、持仓、规则、提案状态或长期记忆。

## Data Flow

### Inputs

- 用户在飞书中的问责/反馈原文。
- 可选日期范围：`from` / `to`。
- `memory/market/pool-snapshots/*.jsonl`。
- `memory/plans/<date>/*.json`。
- `memory/proposals/<date>/*.json`。
- `memory/portfolio/trades.jsonl`。
- `memory/reports/<date>/*.json`。

### Outputs

- `ProblemFeedbackFactPack`：包含日期范围、每日覆盖状态、计划数、提案数、成交数、报告数、标的列表、证据路径、发现和回答指引。
- 飞书自然语言回答：基于事实包解释“看没看、漏在哪、为什么、怎么补”。

### State To Persist

- 事实包本身默认不持久化。
- 可选：后续若需要审计用户反馈处理过程，可追加 metadata-only 审计记录到 `memory/logs/audit-YYYY-MM-DD.jsonl`。

### Audit Records

- 工具调用建议记录：调用时间、日期范围、命中证据数量、缺口数量、是否降级。
- 审计不得记录密钥、完整飞书 token、完整原始长文本或账户敏感信息。

## Configuration

### Required Config

- `FEEDBACK_AUDIT_LOOKBACK_DAYS`：默认回看天数，默认 `7`，可选。
- `FEEDBACK_AUDIT_MAX_RANGE_DAYS`：单次最大检查日期跨度，默认 `31`，可选。
- `FEEDBACK_AUDIT_FULL_POOL_TARGET`：完整观察池目标规模，默认 `100`，可选。

### Secrets

- 是否需要密钥：不需要。
- 密钥来源：无。
- 禁止写入仓库的内容：飞书 app secret、模型 API key、券商账号、真实交易参数、用户隐私原文。

## Error Handling

- 某个 memory 文件不存在时不中断整体事实包，按该证据缺失处理。
- 单个 JSON/JSONL 行解析失败时跳过该行，并在事实包 notes 中标记降级。
- 日期范围非法时使用默认回看窗口或返回明确错误，不让模型猜日期。
- 读取失败必须返回 `ok:false` 或降级 notes，不能编造“已覆盖”。

## Tests Required

### Unit Tests

- 有完整 100 池快照时，日期覆盖状态为 `full`。
- 有计划/提案但没有 100 池快照时，输出“存在计划/提案/成交但缺少完整观察池覆盖证据”。
- 提案和成交必须分开统计，不能把 proposal 当 trade。
- 日期范围、默认回看窗口、最大跨度截断逻辑正确。
- agent 工具 `get_feedback_audit` 只读返回，不产生 trade mutation effect。

### Integration Tests

- 用临时 memory 目录模拟 `pool-snapshots`、`plans`、`proposals`、`trades.jsonl`、`reports` 的组合读取。
- 飞书/agentic 路径中模型收到问责问题时，工具列表包含 `get_feedback_audit`。

### Manual Verification

- 在飞书发送：“上周为什么只操作了两支线，其他的股你确定你有看吗”。
- 回答必须包含日期范围、观察池覆盖证据、缺失日期、提案/成交区分、补救动作。
- 当 memory 缺少快照时，回答必须明确“未找到完整 100 池覆盖证据”。

## Acceptance Criteria

- 飞书问责类问题不再只依赖泛 memory search，而是先取结构化事实包。
- 回答能明确说明哪些日期有 100 池覆盖，哪些日期没有证据或不足 100。
- 回答能区分“操作/成交”和“提案/候选/观察池”，不夸大系统实际行为。
- 全链路按配置运行，先取结构化事实包，再由模型给出判断、解释和补救/执行提案。
- 相关单元测试通过，并说明全量 typecheck 若因无关文件失败，需要单独记录。

## Dependencies

### Depends On Other Proposals

- `none`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

没有就写 `none`。

- none

## Suggested Implementation Order

1. 新增 `ProblemFeedbackFactPack` 只读 use case，先支持日期范围、池快照、计划、提案、成交、报告统计。
2. 将事实包暴露为 agent 只读工具，并在飞书对话提示中要求问责类问题先调用。
3. 补单元测试和临时 memory 集成验证，确认提案/成交区分和缺失证据降级。
4. 更新 app、tests、飞书运维相关 README。
5. 用真实飞书问句手动验证输出是否达到 `docs/display/problem-feedback.md` 期望深度。

## Notes For Coding Agent

后续实现必须保持“事实由代码算、解释由模型写”的边界。不要让 LLM 直接判定是否看过 100 池；LLM 可以引用事实包。不要写账户、不要下单、不要改规则、不要把缺失数据补成看似完整的历史证据。

