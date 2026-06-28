# Proposal: 飞书潜力股池深度分析呈现方案

## Metadata

- proposal_id: `2026-06-28-130731-potential-stock-feishu-analysis-8eb26fa4`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:07:31+08:00`
- suggested_output_path: `docs/proposals/inbox/2026-06-28-130731-potential-stock-feishu-analysis-8eb26fa4.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让用户在飞书里直接请求“潜力股池深度分析”时，得到达到展示样例深度的逐股分析报告，而不是只得到短名单或能力打通级回复。

## Final Decisions

- 潜力股池深度分析属于只读研究/报告能力，不是交易执行能力；服务模型强分析、人工复核和后续执行适配口径。
- 后端先使用确定性数据来源构造候选池上下文，包括 `potential_stocks`、100 高关注池、持仓、行情、资金、题材、趋势和数据健康状态。
- LLM 可负责生成模糊判断和自然语言分析，包括核心逻辑、入选理由、风险解释、跟踪要点和报告表达。
- 买点、止损、目标、仓位只能作为待复核建议展示；不得直接写账户、直接发单或绕过风控。
- 飞书交互应直接返回可读报告正文，覆盖逐股分析、优先级、买入顺序、风险和后续观察点。

## Explicit Non Goals

- 不允许 LLM 直接创建订单、改持仓、改账户、覆盖规则文件。
- 不把展示文档变成静态模板硬编码；报告内容应来自当前候选池和上下文。

## User Value

- 用户在飞书中可以直接获得“可分享、可验证、可跟踪”的潜力股深度报告。
- 报告能解释“为什么选这些股”，而不只是列出股票名称或模型结论。
- 把模糊分析交给模型，把候选边界、风控边界和可审计链路留在代码中。

## Scope

### In Scope

- 读取当前 `potential_stocks` 和/或 100 高关注池作为候选来源。
- 生成最多 10 支潜力股的逐股深度分析。
- 飞书对话中支持“潜力股池深度分析”“推荐潜力股”“现在买什么”等自然语言入口。
- 输出内容包含核心逻辑、入选理由、理想买点、止损、目标、仓位建议、风险点和跟踪要点。
- 模型输出需要结构化校验；失败时提供确定性降级报告。
- 保留“只读分析、未下单、未写账户”的安全说明。

### Out Of Scope

- 长期规则自动改写。
- 前端页面或图形化展示。
- 大规模新闻爬取或无法审计的外部数据缓存。

## Module Mapping

### Existing Modules Likely Affected

- `src/app/agent-planner.ts`：在 `pick_stocks` fulfil 阶段输出深度报告，而不是浅层短名单。
- `src/app/wechat-bridge.ts`：聊天桥需要携带潜力股池富上下文，飞书和微信可共用。
- `scripts/dev/feishu-bot.ts`：飞书入口需要在相关问题上加载 watchlist / potential stock 上下文。
- `scripts/dev/build-context.ts`：统一读取候选池、持仓、行情、题材和数据健康信息。
- `src/domain/brain/turn-planner.ts`：路由提示需要区分“单股深度分析”和“潜力股池一篮子深度分析”。
- `src/domain/market/watchlist.ts`：候选池数据结构仍是确定性边界之一，需保持不由模型直接写入。
- `src/infrastructure/storage/watchlist-memory.ts`：读取 `potential_stocks`，不让报告生成逻辑直接操作文件系统。
- `docs/ops/feishu-bot.md`：说明飞书如何触发潜力股深度分析，以及安全边界。

### New Modules Or Files Proposed

- `src/app/potential-stock-analysis.ts`：应用层用例，负责组装候选上下文、调用 BrainProvider、校验结构化输出、渲染飞书报告。
- `tests/unit/potential-stock-analysis.test.ts`：覆盖结构化模型输出、确定性降级、候选池转换和安全说明。

### README Files To Check Or Update

- `src/app/README.md`：新增 `AnalyzePotentialStocksUseCase` 边界说明。
- `src/domain/brain/README.md`：如新增结构化输出要求，可补充模型只读报告边界。
- `src/domain/market/README.md`：确认 `potential_stocks` 仍是候选池，不是交易指令。
- `docs/ops/feishu-bot.md`：补充飞书触发方式、输出内容和安全说明。
- `tests/unit/README.md`：如新增报告类单测范围，可记录覆盖点。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 候选池来源、候选去重、候选数量上限、池外代码过滤、主板/风控/交易边界和降级路径由代码实现。
- llm_authority: LLM 可负责核心逻辑归纳、题材解释、风险解释、跟踪要点和自然语言报告。
- infrastructure_boundary: 文件系统、行情 provider、飞书 SDK 仍留在 infrastructure/scripts/runtime 侧；app 用例只接收注入上下文和 BrainProvider。
- domain_boundary: domain 不直接请求网络、不读文件、不调模型；market/watchlist 只定义候选池结构和确定性规则。
- auditability: 报告输出应带 provider/model/confidence、候选来源、是否降级、是否未执行交易等 metadata；如后续落盘，应走原子写入和审计。
- simulation_default: 所有建议默认是模拟盘/人工复核建议，`requires_real_trading=no`，不得引入实盘默认路径。

## Core Domain Rules

必须由确定性代码实现的规则：

- 只允许分析后端候选池中的股票，禁止模型引入池外代码。
- 候选数量最多 10 支，重复代码必须去重。
- 买点、止损、目标和仓位只能作为待复核建议，不能转成订单。
- 单票仓位建议需要受显式上限约束，且必须声明需风控复核。
- 已持仓标的必须标记为持仓跟踪，不得被模型当作新买入指令。
- 数据缺失时必须显式降级，禁止编造价格、资金、题材、新闻或业绩。

## Data Flow

### Inputs

- `memory/market/watchlists/potential_stocks.json` 的候选池。
- `memory/market/watchlists/watchlist_today.json` 的 100 高关注池和 pool overview。
- 当前模拟盘账户和持仓快照。
- 最新行情、技术指标、资金面、题材和大盘数据。
- 可选的联网检索摘要。
- 飞书用户原始问题和最近对话摘要。

### Outputs

- 飞书文本报告。
- 结构化潜力股分析对象。
- 安全边界说明：只读分析、未下单、未写账户、需风控复核。

### State To Persist

- 默认不新增持久化状态。
- 如后续要求报告落盘，应写入 `memory/reports` 或专门的 `memory/market/analysis`，并使用原子写入和备份策略。

### Audit Records

- 默认聊天回复可不新增交易审计。
- 如报告落盘，应追加 metadata-only 审计，记录报告 id、候选数量、provider、model、是否降级、输出路径，不记录完整长文本或敏感信息。

## Configuration

### Required Config

- `BRAIN_PROVIDER`：选择模型 provider；默认 `mock`，可选。
- `DASHSCOPE_API_KEY` / `OPENAI_API_KEY`：对应真实 provider 需要；默认无，真实调用时必需。
- `SEARCH_PROVIDER`：是否启用搜索上下文；默认 `none`，可选。
- `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：飞书聊天入口需要；默认无，仅运行飞书时必需。

### Secrets

- 是否需要密钥：真实模型或飞书运行时需要。
- 密钥来源：环境变量或本机密钥管理。
- 禁止写入仓库的内容：API key、飞书 app secret、真实账号、券商凭证、实盘交易参数。

## Error Handling

- 候选池为空时，返回可操作提示，例如先刷新 100 池或跑盘前/集合竞价节点。
- 模型调用失败或结构化输出不合法时，使用确定性降级报告。
- 行情、资金、题材数据缺失时，在报告中明确标注“数据缺失/降级”，不得编造。
- 飞书发送失败不得影响哨兵或闹钟矩阵常驻进程。
- 不允许因为报告生成失败而触发交易动作或账户写入。

## Tests Required

### Unit Tests

- 结构化模型输出能生成完整深度报告。
- 模型输出不合法时能降级为完整报告。
- 候选池去重、池外代码过滤和最多 10 支限制。
- 已持仓标的被标记为持仓跟踪。
- 渲染文本包含核心逻辑、买点、止损、目标、仓位、风险和跟踪点。
- 安全说明包含未下单、未写账户、需风控复核。

### Integration Tests

- 飞书/聊天桥 `pick_stocks` 路由能加载 `potential_stocks` 和 100 池上下文。
- 没有 `potential_stocks` 时能从 100 池 shortlist 降级生成报告。
- Mock BrainProvider 下不联网、不写账户、不接 broker。

### Manual Verification

- 启动飞书机器人后发送“潜力股池深度分析”，确认回复是逐股报告而非短名单。
- 发送“现在买什么/推荐几支潜力股”，确认路由到一篮子分析，不误入单股 deep research。
- 检查报告中所有股票均来自当前候选池。
- 检查没有新增订单、成交、账户写入或真实交易行为。

## Acceptance Criteria

- 飞书里请求“潜力股池深度分析”能返回至少 5 个维度的逐股分析：核心逻辑、理由、买点/止损/目标/仓位、风险、跟踪点。
- 报告中的股票必须全部来自 `potential_stocks` 或 100 高关注池 shortlist。
- 模型失败时仍返回结构完整的降级报告。
- 回复明确标注只读分析、未下单、未写账户。
- 相关单元测试和聊天桥测试通过。

## Dependencies

### Depends On Other Proposals

- `unknown`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

没有就写 `none`。

- none

## Suggested Implementation Order

1. 新增 app 层 `potential-stock-analysis` 用例和 schema，先支持纯输入候选数组生成报告。
2. 把 `pick_stocks` fulfil 从短名单渲染改为调用深度分析用例。
3. 在飞书聊天桥中加载 `potential_stocks` 富上下文和 100 池概览。
4. 更新路由提示，明确“潜力股池深度分析”走一篮子 `pick_stocks`。
5. 补单元测试、聊天桥测试和文档说明。

## Notes For Coding Agent

后续实现保持按配置运行，并把模型作为强研究和强交易判断大脑接入。模型可以生成候选优先级、买卖理由、仓位思路和执行提案；落到账户、订单、规则和长期记忆时由应用层工具、执行适配器和审计链路承接。

