# Proposal: 飞书可追问的成长式策略知识库桥接

## Metadata

- proposal_id: `2026-06-28-130726-strategy-knowledge-bridge-793b0256`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:07:26`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-130726-strategy-knowledge-bridge-793b0256.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让 `docs/display/strategic.md` 期望的“策略库、案例库、决策日志、增长机制”能在飞书交互中基于确定性证据包被查询、解释和反哺，而不是由模型凭空总结。

## Final Decisions

- 采用“桥接方案”：命名策略层叠加在现有回放评分、记忆检索和 Feishu agent 工具面之上，不另起一套与现有系统并行的 `stock_knowledge_base/*.json` 关系库。
- 胜率、样本数、案例状态、策略生命周期建议必须由确定性代码从已评分决策、模拟成交和复盘结果派生，LLM 可负责解释、归纳和自然语言反馈。
- Feishu 深度反馈应通过只读策略知识工具获取 evidence packet，再组织成“当前策略库状态、案例、决策依据、增长机制、缺口/补救动作”的结构化回复。

## Explicit Non Goals

- 不让模型直接覆盖策略、规则、胜率或长期记忆最终版本。

## User Value

- 用户在飞书里问“策略库现在怎么样 / 为什么这次按某策略买 / 这条策略历史胜率如何”时，能得到带证据的深度反馈。
- 每次模拟交易、回放评分和复盘能沉淀为可追踪的策略案例，后续决策时能反哺，而不是停留在散文复盘。

## Scope

### In Scope

- 命名策略本体、`strategy_id`/`strategyIds` 归因、策略指标派生、案例/决策引用汇总、Feishu 只读工具、复盘 consolidation 入口设计。

### Out Of Scope


## Module Mapping

### Existing Modules Likely Affected

- `src/domain/strategy`：承载命名策略、状态、regime 指纹和策略匹配规则。
- `src/domain/decision`：在决策 stance 上保留 `strategyIds` 审计线索。
- `src/app/replay-decider.ts`：基于 as-of 技术状态给回放决策自动挂命名策略。
- `src/app/strategy-knowledge.ts`：从已评分决策派生策略胜率、案例、决策引用和增长机制说明。
- `src/app/brain-agent-tools.ts`：暴露 `get_strategy_knowledge` 只读工具给 Feishu agent。
- `src/app/build-paper-agent-deps.ts`：默认装配策略知识工具，读取 `memory/decisions` 等模拟盘记忆。
- `src/app/load-knowledge-for-wake.ts`：后续把策略命中、样本数和历史案例注入盘前/节点上下文。
- `src/app/distill-daily-knowledge.ts`：后续升级为 consolidation，把已完成决策生成案例和生命周期建议。
- `src/infrastructure/storage/decision-memory.ts`：落盘审计应保留 strategy ids 摘要。
- `memory/decisions`：已评分决策的派生源，不作为模型可直接写入目标。

### New Modules Or Files Proposed

- `src/domain/strategy/*`：命名策略 schema、默认策略种子、regime 指纹匹配。
- `src/app/strategy-knowledge.ts`：只读策略知识 evidence packet 构建和 Markdown/文本渲染。
- `tests/unit/strategy-knowledge.test.ts`：覆盖策略归因、指标派生、案例和渲染。

### README Files To Check Or Update

- `src/domain/strategy/README.md`：说明命名策略层边界。
- `src/app/README.md`：补充策略知识查询用例。
- `src/infrastructure/storage/README.md`：若新增策略案例持久化或审计字段，需要说明写入方式。
- `tests/unit/README.md`：补充策略知识必测范围。
- `docs/architecture/module-map.md`：补充 Strategy 模块或更新现有描述。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 策略匹配、胜率、样本数、案例状态、生命周期建议由代码从已评分决策和模拟成交结果派生。
- llm_authority: LLM 只解释策略、归纳复盘、在飞书里组织中文反馈，不直接写胜率、改规则或发单。
- infrastructure_boundary: 文件读写、Feishu 适配和存储审计留在 infrastructure/app 层；domain 只保留纯 schema 和匹配规则。
- domain_boundary: `src/domain/strategy` 不读文件、不请求网络、不调用模型、不接券商。
- auditability: 每条决策保留 `strategyIds`，评分结果、案例和策略建议都能回链到 decisionId、snapshotId、tradingDate。
- simulation_default: 默认只读取和写入模拟盘记忆；真实交易能力不进入本方案。

## Core Domain Rules

必须由确定性代码实现的规则：

- `strategyIds` 只能作为解释和审计线索，不能作为交易许可或绕过风控的凭证。
- 命中率、平均收益、样本数、成功/失败/持仓中状态必须从可验证的已评分决策或模拟成交结果计算。
- 样本不足时必须显示“待验证”，不能因为种子策略存在而宣称策略有效。
- 策略淘汰、提炼、硬规则变更必须走人工复核提案链，不能自动覆盖规则文件。

## Data Flow

### Inputs

- 已评分回放决策：`memory/decisions/YYYY-MM-DD/*.json`
- 模拟盘提案和成交流水：`memory/proposals`、`memory/portfolio/trades.jsonl`
- 长期复盘/经验：`memory/long_term`、`memory/weekly_reviews`、`memory/reports`
- Feishu 用户问题：例如“策略库现在怎么样”“BUY-001 有效吗”“这笔买入依据是什么”

### Outputs

- Feishu 可读策略知识反馈：策略表、案例表、决策日志摘要、增长机制、当前缺口。
- 盘前/节点大脑上下文中的策略 evidence packet。
- 待人工复核的策略提炼或淘汰建议。

### State To Persist

- 决策 stance 的 `strategyIds`。
- 由 consolidation 生成的策略案例摘要或可重建索引。
- 策略生命周期建议提案，默认 pending review。

### Audit Records

- 决策落盘审计记录应包含去重后的 strategy ids。
- 策略案例生成或生命周期提案应记录来源 decisionId、tradingDate、样本窗口和生成器。
- Feishu 查询本身不需要写账户，但如写入长期经验，必须走现有记忆写入审计。

## Configuration

### Required Config

- `STRATEGY_KNOWLEDGE_ENABLED`：是否启用策略知识只读工具，默认值 `true`，可选。
- `STRATEGY_KNOWLEDGE_MIN_SAMPLE_SIZE`：形成“建议提炼/复核”的最小样本数，默认值 `3`，可选。
- `STRATEGY_KNOWLEDGE_MAX_CASES`：Feishu 单次返回案例上限，默认值 `10`，可选。

### Secrets

- 是否需要密钥：不需要新增密钥。
- 密钥来源：沿用已有 Feishu/Brain provider 环境变量；本方案不新增。
- 禁止写入仓库的内容：Feishu app secret、模型 API key、真实账户号、真实 broker 参数、任何实盘权限凭据。

## Error Handling

- `memory/decisions` 不存在或为空时，返回“暂无已评分样本/待验证”，而不是报错或编造胜率。
- 单个决策文件损坏时跳过该文件并在 notes 中提示降级，不阻断其他样本统计。
- Feishu 工具不可用时降级为普通说明，并明确“没有策略证据包”。
- 样本不足、结果未实现、平仓未完成时显示“待验证/持仓中”，不得按 0 或 100% 误导。

## Tests Required

### Unit Tests

- `deriveStrategyIdsForStance`：覆盖低位买入、主线补涨、近高位卖出、持仓观望、风险减配。
- `buildStrategyKnowledgeDigest`：覆盖胜率、样本数、案例状态、决策引用、空数据降级。
- `renderStrategyKnowledgeDigest`：覆盖 Feishu 可读结构和样本不足文案。
- `get_strategy_knowledge` 工具：只读、参数校验、无 effect/mutation。

### Integration Tests

- 用临时 `memory/decisions` 写入多日 scored decisions，验证策略知识工具读取和汇总。
- Feishu/agent turn 使用 mock tool provider 触发 `get_strategy_knowledge`，验证回复引用工具事实，不执行交易。
- 晚间 consolidation 读取当天模拟成交和评分结果，验证案例生成和审计记录。

### Manual Verification

- 在飞书私聊中问“策略库现在怎么样”，应返回策略表、案例表、决策日志和增长机制。
- 问“BUY-001 是否有效”，应返回样本数、胜率、案例和“待验证/建议提炼/建议复核”。
- 清空或隔离 `memory/decisions` 后再问，应明确暂无样本，不编造历史。

## Acceptance Criteria

- Feishu 中可获得与 `docs/display/strategic.md` 同等深度的策略库反馈，且关键数字来自确定性 evidence packet。
- 任一策略胜率和案例都能追溯到具体 decisionId/tradingDate，且不会触发 broker 或账户写入。
- 样本不足、工具失败或数据缺失时有明确降级文案。

## Dependencies

### Depends On Other Proposals

- `unknown`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

- 真实模拟成交提案是否统一增加 `strategyIds` 字段，还是通过 rationale/metadata 做兼容归因？
- consolidation 生成案例时，以 forward-return scorer 为准，还是以真实 paper sell/closed position PnL 为准？
- 策略生命周期建议是否复用现有 rule proposal 存储，还是新增 strategy proposal 类型？

## Suggested Implementation Order

1. 建立 `src/domain/strategy` 命名策略层和 `strategyIds` 决策归因，保持 domain 纯函数。
2. 实现只读 `strategy-knowledge` evidence packet，从 scored decisions 派生策略指标、案例和决策日志。
3. 把 `get_strategy_knowledge` 接入 Feishu agent 工具面，并更新提示词要求先取证据再回答。
4. 将漏斗/模拟成交提案接入 `strategyIds`，让真实 paper 操作也能归因。
5. 升级盘后 consolidation，生成案例、重算生命周期建议，并通过人工复核链处理策略提炼/淘汰。

## Notes For Coding Agent

后续实现必须保持模拟盘默认路径。不要让 LLM 直接写策略胜率、改规则或发单；所有交易相关结果都必须经现有 Policy/Risk/PaperBroker/审计链。OpenClaw 只能借鉴“工具化证据包 + 会话记忆压缩”的架构思路，不复制其业务代码。

