# Proposal: 盘前市场背景飞书深度呈现契约

## Metadata

- proposal_id: `2026-06-28-130649-pre-market-feishu-depth-b7e3a9c1`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:06:49+08:00`
- suggested_output_path: `docs/proposals/inbox/2026-06-28-130649-pre-market-feishu-depth-b7e3a9c1.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让 `docs/display/pre-market.md` 所示的盘前市场背景深度，稳定出现在飞书主动闹钟推送和手动“盘前计划”交互中，同时保持数据事实由确定性代码产生、LLM 可负责组织表达。

## Final Decisions

- 盘前呈现不能只依赖通用 `generateReport(pre_market_plan)`，应走小脑闹钟 / 飞书 SOP 链路，把真实行情、指数、观察池、市场宽度、成交额、热点板块、连板与封单上下文注入大脑。
- 大盘点位、涨跌幅、涨跌家数、涨停跌停、成交额、放量缩量、板块涨幅榜、观察池分类、连板天数、封单/一字板等事实必须来自 provider / domain / app 的确定性数据包；模型不得自行编造。
- 08:30 `pre_market_plan` 主动推送和飞书私聊手动触发“做个盘前计划”必须共享同一套盘前展示契约，避免一个路径深、另一路径浅。
- 飞书推送内容必须以 `summary` 为唯一人类可见正文来设计，不能把关键细节藏在 `structured` 字段中。
- 若指数、成交额、板块、连板或新闻数据缺失，模型必须在报告中显式写“数据缺失/降级”，而不是用记忆或常识补数字。
- 盘前建议可以形成强策略判断、候选优先级和执行提案；是否成交必须来自后续执行链路的真实回执或账本证据。

## Explicit Non Goals

- 不用 LLM 计算涨停、连板、仓位、风控、T+1、买卖数量或账户变更。
- 不做 UI 页面或前端落地；本方案只覆盖飞书/通知文本呈现。
- 不要求每个盘前字段都有实时外部源；缺源时必须诚实降级。

## User Value

- 用户在飞书里收到的 08:30 盘前内容不再是泛泛“今日谨慎观察”，而是直接看到大盘、量能、涨跌家数、热点板块、连板梯队和模拟盘操作框架。
- 后续 Codex 会话可以按同一方案继续实现或校验，不需要重新从 `docs/requirements` 和展示样张中推断目标深度。

## Scope

### In Scope

- 定义盘前展示契约，要求输出包含“市场背景 / 大盘情况 / 热点板块 / 连板股 / 剑盾双修 / 操作汇报”。
- 将展示契约接入定时闹钟 `pre_market_plan` 和飞书手动 SOP 的同一模型上下文。
- 确保上下文字段来自现有 Market、Cerebellum、Provider、Storage、App use case，而不是 prompt 里的示例数据。
- 确保推送文本长度足以容纳完整盘前背景，且缺数据时仍能推送降级说明。
- 为 prompt 契约和手动 SOP 路径补单元测试。

### Out Of Scope

- 新增前端页面、图表 UI 或移动端展示。
- 重写全市场数据 provider。
- 强制接入新的付费数据源。
- 用模型替代现有确定性风控、选股池构造、T+1 或资金计算。

## Module Mapping

### Existing Modules Likely Affected

- `src/app/alarm-brain.ts`：定时闹钟 SOP 到大脑的核心编排点，需要注入盘前展示契约和确保 summary 推送完整。
- `src/app/agent-planner.ts`：飞书私聊手动触发 SOP 的编排点，需要与闹钟路径共用盘前展示契约。
- `scripts/dev/build-context.ts`：盘前真实上下文来源，包含指数、观察池、板块、成交额、连板、封单、资金面、联网检索等数据拼装。
- `scripts/dev/cerebellum-daemon.ts`：08:30 固定闹钟、全市场探查、100 池换血、飞书主动推送的运行链路。
- `src/domain/market/*`：市场事实口径，包括指数、theme heat、sector heat、limit state、seal board、market phase、watchlist。
- `src/domain/cerebellum/*`：固定闹钟、SOP、安全边界和小脑事件。
- `src/domain/notification/*`：通知 schema、推送门禁、summary 长度、外部渠道安全边界。
- `src/infrastructure/providers/*`：腾讯、东方财富、新浪、Tavily 等外部数据和搜索适配器。
- `src/infrastructure/notification/feishu-notifier.ts`：飞书主动推送文本渲染和脱敏。
- `tests/unit/alarm-brain.test.ts`：验证定时闹钟路径携带盘前呈现契约。
- `tests/unit/agent-planner.test.ts`：验证手动 SOP 路径携带盘前呈现契约和真实上下文。

### New Modules Or Files Proposed

- `src/app/pre-market-display-contract.ts`：集中保存盘前展示契约，供定时闹钟和手动 SOP 复用。
- `tests/unit/pre-market-display-contract.test.ts`：可选，若契约逻辑未来变复杂，单独验证节点匹配和文案约束。
- `docs/proposals/inbox/2026-06-28-130649-pre-market-feishu-depth-b7e3a9c1.md`：本 proposal 归档文件。

### README Files To Check Or Update

- `src/app/README.md`：说明 `pre_market_plan` 不只是通用报告，而是飞书可见的盘前市场背景 SOP。
- `src/domain/cerebellum/README.md`：补充 08:30 盘前节点的数据要求和降级规则。
- `src/domain/notification/README.md`：说明 scheduled node summary 可能较长，但仍需脱敏和禁止交易执行。
- `docs/ops/feishu-bot.md`：说明飞书手动“盘前计划”和主动闹钟推送的呈现深度一致。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 行情解析、指数、涨跌家数、涨停跌停、连板、封单、成交额、放量缩量、观察池分类、仓位和可卖数量都由 TypeScript 确定性代码计算。
- llm_authority: LLM 可负责解释新闻、归纳板块逻辑、组织盘前报告、给出模拟盘操作思路和待人工复核建议。
- infrastructure_boundary: 腾讯、东方财富、新浪、Tavily、飞书 SDK 等外部依赖只放在 `src/infrastructure` 或 scripts 适配层，领域层不直接调用网络。
- domain_boundary: `src/domain/market` 和 `src/domain/cerebellum` 只定义模型、口径、纯规则和事件，不读写文件、不调用模型、不提交 broker。
- auditability: 盘前上下文来源、观察池快照、通知事件、模型输出和模拟盘提案都应保留可追溯元数据；写入 memory 时走存储层。
- simulation_default: 所有建议默认面向 paper account；任何买卖只可落为模拟盘提案或经 paper-only 执行路径，真实交易保持关闭。

## Core Domain Rules

必须由确定性代码实现的规则：

- 指数、涨跌家数、涨停/跌停数量、成交额、放量/缩量、板块涨幅榜、连板天数、封单/一字板标签必须来自 provider 数据和 domain/app 计算结果。
- 缺失字段必须显式降级，不能由模型用记忆、新闻或常识补齐数字。
- 主板过滤、100 股整数、T+1、现金约束、单股仓位上限、止损、禁买、熔断仍由现有 PolicyEngine/RiskEngine/PaperBroker 执行。
- 飞书主动推送和手动 SOP 必须共享同一盘前展示契约，避免同一语义不同入口输出不一致。
- LLM 输出的任何买卖判断不得直接写账户或提交 broker，只能是模拟盘建议、待买卖提案或人工复核文本。

## Data Flow

### Inputs

- 腾讯实时行情和指数快照。
- 东方财富 / 新浪 universe、行业、概念、成交额、主力净流入等可用市场宽度数据。
- 本地 `memory/market/watchlists/watchlist_today.json` 的观察池和 `poolOverview`。
- 本地 `memory/market/limit-board/*.json` 的涨停、跌停、连板历史。
- 本地 `memory/market/turnover/*.json` 的成交额对比基线。
- 模拟盘账户、持仓、可卖数量、成本价和现价。
- 可选 Tavily 新闻/政策检索结果。
- 过往复盘教训和长期记忆检索结果。

### Outputs

- 飞书主动推送的 08:30 盘前市场背景报告。
- 飞书手动“盘前计划”回复。
- 可选模拟盘待买/待卖提案摘要。
- 数据缺失或降级说明。

### State To Persist

- 观察池快照和分类概览。
- limit-board 快照，含连板 streak。
- turnover 快照，供放量/缩量对比。
- 通知事件、运行健康、必要时的报告或计划记录。
- 模拟盘提案和纸面成交记录，仅在后续 funnel/paper-only 路径中产生。

### Audit Records

- scheduled node notification metadata：`alarmType=pre_market_plan`、`brokerConnected=false`、`directExecutionAllowed=false`、`liveTrading=false`。
- 观察池换血和 pool snapshot 的时间、来源、数量、降级状态。
- 若生成交易意图或 memory write proposal，必须记录 review-required proposal 元数据。
- 推送失败、provider 降级、数据缺失应进入运行日志或 runtime health。

## Configuration

### Required Config

- `BRAIN_PROVIDER`：用于生成自然语言盘前报告；默认可为 `mock`，真实效果建议 `dashscope` 或其它已实现 provider；可选但 mock 只适合测试。
- `FEISHU_NOTIFY`：是否启用飞书主动推送；默认关闭；可选。
- `FEISHU_APP_ID`：飞书应用 ID；仅启用飞书时需要。
- `FEISHU_APP_SECRET`：飞书应用 Secret；仅启用飞书时需要，必须来自环境变量。
- `FEISHU_ALLOWED_USERS` / `FEISHU_PUSH_USERS`：飞书接收人 open_id；默认空；主动推送需要至少一个接收人。
- `SEARCH_PROVIDER`：新闻检索 provider；默认可为 `none`；启用 Tavily 时用于隔夜消息和早盘热点补充。
- `TAVILY_API_KEY`：Tavily key；仅 `SEARCH_PROVIDER=tavily` 时需要。
- `MARKET_QUOTE_TIMEOUT_MS` 或现有行情超时配置：控制 provider 超时；默认沿用项目配置。

### Secrets

- 是否需要密钥：需要，若启用真实大脑、飞书或 Tavily。
- 密钥来源：只允许环境变量或本机密钥管理。
- 禁止写入仓库的内容：飞书 app secret、模型 API key、Tavily key、真实账户凭证、真实 broker 参数、个人 open_id 以外的敏感身份信息。

## Error Handling

- 行情、指数、universe、资金流或新闻检索失败时，保留已有观察池或降级为空，并在报告中写明数据缺失。
- 观察池换血返回空时，不覆盖上一份有效池，避免 transient provider failure 破坏次日上下文。
- 模型超时或结构化输出异常时，应返回明确错误或 mock/降级文本，不得编造盘前数据。
- 飞书推送失败不能导致哨兵或闹钟 daemon 崩溃；只记录错误并继续值守。
- 通知文本必须脱敏，避免把 token、apiKey、password、secret 等写入飞书。
- 报告超长时可以按通知 schema 上限截断，但应优先保留市场背景和操作结论。

## Tests Required

### Unit Tests

- `runAlarmNodeAnalysis(pre_market_plan)` prompt 必须包含“盘前市场背景呈现 / 大盘情况 / 热点板块 / 连板股”。
- `fulfilTurnPlan(run_sop: pre-market-plan)` prompt 必须包含同一展示契约。
- 缺数据上下文下 prompt 必须要求模型写“数据缺失”，不能暗示可编造。
- 通知 summary 上限应允许完整盘前报告超过旧 1000 字限制，并仍通过 schema。
- push policy 应继续允许 scheduled node report 推送，但不放开普通噪声告警。

### Integration Tests

- `cerebellum-daemon --fire pre_market_plan` 在 mock provider 下能完整走通：换血、构造上下文、生成通知、不下单。
- 飞书 notifier 使用注入 sender 时能发送长文本并脱敏。
- `buildBridgeContext(includeWatchlist=true, alarmType=pre_market_plan)` 能返回 watchlist、poolOverview、indices、dataHealth，provider 失败时降级不抛出。

### Manual Verification

- 运行 `npm run cerebellum:dev -- --fire pre_market_plan`，检查控制台和飞书推送是否先展示市场背景，再给剑盾和操作建议。
- 在飞书私聊输入“做个盘前计划”，确认回复与主动推送深度一致。
- 在关闭 Tavily 或断开部分行情源时，确认报告写明数据缺失，不出现凭空指数、板块或连板名单。

## Acceptance Criteria

- 08:30 `pre_market_plan` 飞书主动推送开头包含“市场背景”，并覆盖大盘情况、市场宽度、成交额、热点板块、连板股或明确降级说明。
- 飞书手动“盘前计划”与定时闹钟使用同一展示契约，不再退化为普通问答。
- 报告中的指数、涨停跌停、涨跌家数、成交额、板块、连板、封单等数字均可追溯到确定性上下文。
- LLM 不直接执行交易、不写账户、不覆盖规则、不启用实盘。
- provider 失败、数据缺失、推送失败都有清晰降级路径，不导致 daemon 崩溃。
- 新增或调整的逻辑有单元测试覆盖，`npm run typecheck` 和 `npm test` 通过。

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

1. 抽取盘前展示契约到 app 层共享文件，明确市场背景结构、缺数据降级、禁止编造和模拟盘边界。
2. 将契约接入 `runAlarmNodeAnalysis(pre_market_plan)` 和 `fulfilTurnPlan(run_sop: pre-market-plan)`。
3. 确认 `buildBridgeContext` 在盘前路径中提供 indices、themeHeat、poolOverview、dataHealth、webSearch 和观察池。
4. 如旧通知 schema 仍限制 1000 字，提升 scheduled report summary 上限并保持脱敏。
5. 补单元测试和手动验证脚本说明。
6. 更新相关 README，说明飞书主动推送和手动 SOP 的盘前深度一致。

## Notes For Coding Agent

后续实现必须先读 `AGENTS.md`、项目 README、架构 README、module map 和目标模块 README。不要把展示样张里的数字硬编码进代码或 prompt；它们只是目标形态。所有事实字段先由确定性数据链路产生，LLM 只组织表达。任何买卖建议都保持 simulation / paper-only，真实交易能力不得因本 proposal 打开。

