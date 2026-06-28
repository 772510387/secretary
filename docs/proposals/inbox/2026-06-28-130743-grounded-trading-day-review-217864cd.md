# Proposal: 接地交易日复盘与飞书深度反馈

## Metadata

- proposal_id: `2026-06-28-130743-grounded-trading-day-review-217864cd`
- slug: `grounded-trading-day-review`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28T13:07:43+08:00`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-130743-grounded-trading-day-review-217864cd.md`
- proposal_type: `feature`
- priority: `P0`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

把 `docs/display/trading-day-review.md` 这种完整交易日复盘从模型叙述升级为可审计、可落盘、可在飞书中直接反馈的确定性事实复盘。

## Final Decisions

- 复盘数字必须来自账户快照、成交账本、持仓估值、提案理由和审计记录；缺失数据必须显式显示“未记录/未确认”，不能让 LLM 补齐。
- 飞书交互中“完整交易日复盘/接地复盘/逐节点复盘”应走确定性快路，而不是普通聊天或自由 SOP 复盘。

## Explicit Non Goals

- 不在 P0 中强行伪造分钟级行情曲线；没有分时数据源时只展示已有成交/节点价格，并写明数据边界。

## User Value

- 用户在飞书里能看到接近样例深度的“最终战绩、操作统计、关键决策、走势对照、逐节点逻辑、改进项”，而不是泛泛收盘摘要。
- 复盘可追问、可审计、可回放，避免出现 UTC 时间、成交理由、盈亏数字由模型临场编造的问题。

## Scope

### In Scope

- 生成交易日复盘事实包：期初/期末资产、日盈亏、已实现/浮动盈亏、成交统计、北京时间成交线、最终持仓、数据质量说明。
- 生成 Markdown 复盘报告并保存到 `memory/reviews/YYYY-MM-DD/trading-day-review.md`。
- 从 `intentId -> proposalId` 读取提案 rationale；无理由时显示“未记录”。
- 飞书入口识别“完整/接地/交易日/逐节点复盘”并返回接地报告。
- 模拟运维或补跑完成后可追加同一份交易日复盘报告。

### Out Of Scope

- 分钟/tick 行情源接入和历史分时回放。
- 周/月/年收益率、夏普、年化、真实资金曲线等高阶绩效指标。
- UI 页面或前端图表。

## Module Mapping

### Existing Modules Likely Affected

- `src/app`：新增复盘事实包和 Markdown 报告编排用例。
- `src/domain/portfolio`：复用账户、持仓、成交、估值和 T+1 相关模型与计算。
- `src/infrastructure/storage`：复用原子写入能力保存复盘报告。
- `src/app/wechat-bridge.ts`：增加飞书/聊天入口的接地复盘快路。
- `scripts/dev/feishu-bot.ts`：将飞书消息解析到具体交易日并调用复盘用例。
- `scripts/dev/agent-actions.ts`：模拟运维完成后可追加生成同日接地复盘。
- `tests/unit`：补充事实包、渲染、飞书路由和数据缺口测试。

### New Modules Or Files Proposed

- `src/app/build-review-factpack.ts`：从账本和快照构造确定性复盘事实包。
- `src/app/trading-day-review.ts`：把事实包渲染为 Markdown，校验关键数字并落盘。
- `tests/unit/trading-day-review.test.ts`：覆盖资产、盈亏、北京时间、理由 join 和缺失数据行为。

### README Files To Check Or Update

- `src/app/README.md`：登记 `TradingDayReviewUseCase` 和边界。
- `src/domain/portfolio/README.md`：若新增已实现盈亏或成本批次规则，需要同步计算口径。
- `tests/unit/README.md`：补充复盘事实包和交易日复盘测试覆盖点。
- `docs/ops/feishu-bot.md`：如果飞书新增触发语义或使用说明，需要同步。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 资产、盈亏、成交统计、北京时间归一、成本配对、数据缺口全部由 TypeScript 确定性代码完成。
- llm_authority: LLM 可以基于事实包写亮点、改进、解释性文字或自然语言摘要，不能新增事实数字。
- infrastructure_boundary: 文件读写和飞书 SDK 仍在 infrastructure/scripts/entry 层；领域层不直接读文件、不联网、不调模型。
- domain_boundary: Portfolio/Trading/Risk 规则继续留在 domain；app 只编排复盘用例和数据 join。
- auditability: 复盘报告必须标明事实来源、缺失数据和落盘路径；关键数值可从账本和快照追溯。
- simulation_default: 默认只读/模拟盘路径，不触发 broker，不写账户，不启用实盘。

## Core Domain Rules

必须由确定性代码实现的规则：

- `tradedAt` 必须统一转为北京时间展示，不能交给模型解释 UTC。
- 已实现盈亏只能在存在可回溯成本批次时计算；缺成本时显示“未确认”，不能估算。
- 买入/卖出次数、股数、成交额、最终持仓必须从 `TradeRecord` 和 `Position` 计算。
- 复盘不得生成真实订单、不得修改账户、不得覆盖规则文件。

## Data Flow

### Inputs

- `memory/portfolio/account.json`
- `memory/portfolio/positions.json`
- `memory/portfolio/trades.jsonl`
- `memory/portfolio/snapshots/YYYY-MM-DD.json`
- `memory/portfolio/daily-summary.jsonl`
- `memory/proposals/YYYY-MM-DD/*.json`
- 可选：回放/闹钟节点结果、节点价格、节点报告摘要。

### Outputs

- 面向飞书的 Markdown 文本。
- `memory/reviews/YYYY-MM-DD/trading-day-review.md`
- 可选：复盘生成审计事件或报告 metadata。

### State To Persist

- 交易日复盘 Markdown。
- 后续可扩展：复盘 fact pack JSON，用于后续追问和二次校验。

### Audit Records

- 复盘报告落盘事件应记录：交易日、报告路径、输入摘要、是否数据缺失、是否使用模型摘要。
- 不记录密钥、完整 prompt、飞书 token 或真实账号敏感信息。

## Configuration

### Required Config

- `TRADING_REVIEW_WRITE_ENABLED`：是否允许落盘复盘报告，默认 `true`，可选。
- `TRADING_REVIEW_MAX_FEISHU_CHARS`：飞书单条消息最大长度，默认按当前发送器限制处理，可选。
- `TRADING_REVIEW_FACTPACK_JSON_ENABLED`：是否额外保存 fact pack JSON，默认 `false`，可选。

### Secrets

- 是否需要密钥：不需要新增密钥。
- 密钥来源：如飞书机器人已配置，继续来自 `.env` / 本机环境变量。
- 禁止写入仓库的内容：`FEISHU_APP_SECRET`、LLM API key、真实券商账号、真实交易参数、完整用户隐私消息。

## Error Handling

- 缺少当日快照时，退回当前账户和持仓估值，并在数据边界说明。
- 缺少前一交易日快照时，期初资产只能退回账户初始资金或显示无法确认。
- 缺少提案 rationale 时，每笔成交理由显示“未记录”。
- 复盘落盘失败时，飞书仍返回可生成的 Markdown，并明确告知未落盘。
- 模型摘要失败时，继续返回确定性复盘，不影响账本事实。

## Tests Required

### Unit Tests

- 资产起点/终点、日盈亏、收益率计算。
- 买入/卖出次数、股数、成交额统计。
- 卖出成本配对、已实现盈亏、缺成本时不计算。
- `tradedAt` 转北京时间。
- `intentId -> proposalId -> rationale` join。
- Markdown 渲染必须包含关键事实值，不能漏掉数据边界。
- 飞书桥识别“完整交易日复盘/接地复盘”时不走普通模型路由。

### Integration Tests

- 使用临时 `memory` 目录，从账户、持仓、成交、快照、提案文件生成并落盘复盘报告。
- 运维或执行流程完成后追加生成同日复盘，并保留执行适配器与审计线索。
- 缺文件、坏 JSON、空成交、空持仓场景降级可解释。

### Manual Verification

- 在飞书发送“来一个今天完整交易日复盘”，检查返回是否包含最终战绩、操作统计、关键决策、逐节点逻辑和数据边界。
- 检查 `memory/reviews/YYYY-MM-DD/trading-day-review.md` 是否落盘。
- 对照 `trades.jsonl` 和 `daily-summary.jsonl` 核对金额、股数、北京时间。

## Acceptance Criteria

- 飞书中请求完整交易日复盘时，返回的是账本接地报告，而不是自由聊天复盘。
- 报告中的资产、盈亏、成交次数、股数、价格、北京时间均可从本地事实源追溯。
- 缺少分时、成本或理由时，报告明确写缺口，不编造。
- 默认不接实盘、不触发 broker、不写账户、不改规则。

## Dependencies

### Depends On Other Proposals

- `none`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

- P1 是否接入分钟级行情 provider，用真实分时价格补全“股价走势与操作对照”。
- 是否额外保存 fact pack JSON，方便后续飞书追问“这笔为什么这么算”。
- 跨日成本批次是否需要从当前快照扩展为独立持久化 ledger，以保证所有卖出都能完整计算已实现盈亏。

## Suggested Implementation Order

1. 实现 `TradingDayReviewFactPack`：只读账本、快照、成交和提案，生成确定性事实包。
2. 实现 Markdown 渲染和关键数值校验，缺失数据明确降级。
3. 接入飞书桥和模拟运维结果追加复盘，确保按配置运行。
4. 补齐单元测试、临时目录集成测试和 README。
5. 评估 P1 分时行情源和 fact pack JSON 落盘。

## Notes For Coding Agent

后续实现必须先读 `AGENTS.md`、根 `README.md`、架构文档和目标模块 README。不要把 LLM 放进金额、股数、成本、盈亏、T+1 或订单判断链；LLM 可以解释事实包。所有写入使用原子写入和备份策略，默认只处理模拟盘，不新增密钥，不启用真实交易。

