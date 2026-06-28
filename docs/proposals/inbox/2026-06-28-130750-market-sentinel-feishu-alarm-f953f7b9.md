# Proposal: 盘中哨兵与飞书闹钟深度联动

## Metadata

- proposal_id: `2026-06-28-130750-market-sentinel-feishu-alarm-f953f7b9`
- slug: `market-sentinel-feishu-alarm`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28T13:07:50+08:00`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-130750-market-sentinel-feishu-alarm-f953f7b9.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `L`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

把 `docs/display/daily-alarm-list.md` 的闹钟矩阵、3 秒级行情哨兵、链式静默巡航和飞书交互整合成按配置运行的全天候值守能力。

## Final Decisions

- 采用 TypeScript 分层实现，不新增独立的无边界 `market_sentinel.js` 规则脚本；常驻进程只做装配和生命周期，确定性红线仍落在 `domain/cerebellum`。
- 盘中行情哨兵按交易时段 3 秒轮询腾讯实时行情；普通轮询零 token，只有固定闹钟或红线事件才唤醒 BrainProvider 生成研判和飞书消息。
- 闹钟必须对齐 `daily-alarm-list.md`：必报点无条件推送，链式监控点默认静默，仅在持仓或指数触发红线后汇报。
- 飞书不是简单通知出口，而是值守交互入口：支持接收必报、红线、模拟操作结果，并允许用户查询状态、手动重放闹钟、追问研判。
- 所有交易相关动作保持模拟盘默认；LLM 可以生成解释、研判、报告或人工提案，不能直接改账户、下单或覆盖规则。

## Explicit Non Goals

- 不让 LLM 每 3 秒参与盯盘，也不把红线条件写成 prompt。
- 不把密钥、账号、真实交易参数或飞书凭据写入仓库。

## User Value

- 用户不需要定时手动唤醒助手查看行情；系统在盘中持续低成本盯盘，异常时主动进入飞书。
- 固定闹钟、链式巡航、红线哨兵和模拟盘上下文形成闭环，用户在飞书里能看到可追问、可审计、可复盘的深度结果。

## Scope

### In Scope

- 对齐工作日盘前、竞价、盘中、尾盘、收盘、晚间的必报闹钟和链式静默巡航点。
- 实现或校准 3 秒级行情哨兵规则：1 分钟急涨急跌、持仓涨跌幅红线、突破前高、指数剧烈波动、止损风险和冷却去重。
- 将哨兵、闹钟矩阵、链式巡航和飞书长连接整合为可常驻的模拟盘值守入口。
- 为红线触发、固定报告、飞书推送、冷却状态、巡航激活原因和审计记录补齐测试与文档。
- 补齐 `daily-alarm-list.md` 中尚未覆盖的周末、月度、年度和 21:00 晚间内省类任务设计或实现记录。

### Out Of Scope

- UI 大屏、移动端应用和 Web 控制台。
- 外部新闻搜索能力的无限制联网抓取；需要时必须走 infrastructure/provider 边界并可降级。

## Module Mapping

### Existing Modules Likely Affected

- `src/domain/cerebellum`：承载哨兵规则、固定闹钟、链式巡航、事件 schema 和唤醒策略。
- `src/domain/notification`：承载通知级别、去重、冷却、飞书外部推送资格和本地降级策略。
- `src/domain/market`：提供行情快照、指数快照和交易时段相关领域模型。
- `src/domain/portfolio`：提供持仓、成本价、可用数量和模拟盘上下文。
- `src/domain/risk`：提供止损、熔断、禁买和仓位红线的确定性约束。
- `src/app`：编排哨兵事件到报告、飞书交互、模拟操作建议和手动重放用例。
- `src/runtime`：组合配置、provider、scheduler、notifier、brain 和 graceful shutdown。
- `src/infrastructure/providers`：适配腾讯行情、指数行情、模型 provider，不把 SDK 泄漏到领域层。
- `src/infrastructure/scheduler`：提供北京时间固定任务、盘中循环、防重入和常驻进程停止。
- `src/infrastructure/notification`：实现飞书发送、mock notifier 和外部通道错误处理。
- `scripts/dev`：提供开发态常驻 daemon、手动触发和验证入口。
- `memory`：保存报告、审计、冷却账本、巡航状态和模拟盘运行沉淀。

### New Modules Or Files Proposed

- `docs/proposals/inbox/2026-06-28-130750-market-sentinel-feishu-alarm-f953f7b9.md`：沉淀本方案，供后续 Codex 会话读取。
- `memory/cerebellum/activation-state.json`：建议的巡航激活状态账本，记录 activationReason、nextCheckpoint 和过期时间。
- `memory/cerebellum/sentinel-cooldown.json`：建议的哨兵冷却账本，避免同类红线刷屏。
- `memory/audit/*.jsonl`：建议继续使用或扩展的审计落盘位置，记录闹钟、哨兵、飞书推送和模型唤醒链路。

### README Files To Check Or Update

- `README.md`：说明 `npm start` 是否为全天候值守入口，以及模拟盘默认边界。
- `src/domain/cerebellum/README.md`：同步哨兵红线、闹钟矩阵、链式巡航和禁止项。
- `src/domain/notification/README.md`：同步 warning/critical 红线进入飞书、本地降级和冷却策略。
- `src/infrastructure/scheduler/README.md`：同步 3 秒轮询、显式巡航槽位、固定闹钟和防重入规则。
- `docs/ops/feishu-bot.md`：同步飞书启动、推送条件、用户交互命令和故障排查。
- `tests/unit/README.md`：同步必须覆盖的哨兵、闹钟、巡航和通知策略测试。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 红线、冷却、闹钟到点、链式激活、是否推送飞书、是否允许模拟操作都由 TypeScript 规则判断。
- llm_authority: 新闻解释、盘面研判、策略推演、报告生成、飞书追问回答和复盘总结。
- infrastructure_boundary: 腾讯行情、飞书、模型 SDK、文件系统和未来 broker 适配全部放在 infrastructure 或 runtime 装配层。
- domain_boundary: `domain` 只接收已标准化输入并返回事件、任务、策略结论和审计草稿，不直接联网、不读写文件、不调用模型。
- auditability: 每次固定闹钟、哨兵红线、BrainProvider 唤醒、飞书推送、模拟操作建议和冷却跳过都要有 correlationId 或 auditEventId。
- simulation_default: 运行模式由配置决定；模型可形成强行情判断、策略推演和执行提案，执行侧由适配器与审计链路承接。

## Core Domain Rules

必须由确定性代码实现的规则：

- 交易日和交易时段内 3 秒轮询，非交易时段降频或停止高频请求。
- 1 分钟内急涨急跌阈值、持仓涨跌幅红线、止损红线、突破前高和指数系统性风险阈值。
- `daily-alarm-list.md` 的必报点和链式静默巡航点，固定闹钟不得被普通冷却吞掉。
- 同一股票同类事件按 `eventType:market:symbol` 冷却，critical 事件必须保留本地审计。
- 飞书外部推送只发送必报报告、warning/critical 红线、模拟操作结果和用户请求结果；普通 watch 巡航脉冲默认本地保留。
- BrainProvider 唤醒条件必须可解释，包含 alarmId、eventId、activationReason 或用户请求来源。
- LLM 输出不能直接生成订单执行，只能进入模拟盘提案、报告或人工确认路径。

## Data Flow

### Inputs

- 腾讯实时行情和指数行情快照。
- 模拟盘账户、现金、持仓、成本价和 watchlist。
- 固定闹钟矩阵、链式巡航槽位和交易时段。
- 飞书用户消息、手动重放请求和状态查询。
- 已持久化的冷却状态、上一轮行情快照和巡航激活状态。

### Outputs

- `CerebellumEvent`、固定闹钟任务、静默巡航任务和研究任务。
- 飞书消息、本地通知、文件通知和模拟盘报告。
- BrainProvider 研判结果、操作建议草案和复盘文本。
- 审计事件、冷却账本更新和巡航状态更新。

### State To Persist

- 上一轮行情快照或足以计算窗口变化的轻量 quote history。
- 哨兵冷却账本和通知去重账本。
- 链式巡航激活状态：activationReason、activatedAt、nextCheckpoint、expiresAt、relatedEventIds。
- 固定闹钟执行记录和同一分钟防重复记录。
- 飞书推送结果、失败重试记录、BrainProvider 调用 metadata 和模拟盘报告。

### Audit Records

- `alarm_due`：固定闹钟到点和上下文包构造。
- `sentinel_check`：哨兵检查摘要、命中数量、冷却跳过数量和 provider 状态。
- `sentinel_redline`：具体红线事件、阈值、当前值、上一值和推荐动作。
- `brain_wakeup`：模型被唤醒的原因、输入摘要、禁止动作和输出摘要。
- `notification_dispatched`：飞书或本地通知发送结果、渠道、dedupeKey 和错误信息。
- `paper_action_proposed`：模拟盘操作建议或人工确认草案，不代表真实成交。

## Configuration

### Required Config

- `MARKET_SENTINEL_INTERVAL_MS`：盘中哨兵轮询间隔，默认 `3000`，可选。
- `MARKET_SENTINEL_RAPID_MOVE_THRESHOLD`：窗口急涨急跌阈值，默认 `0.02`，可选。
- `MARKET_SENTINEL_RAPID_MOVE_WINDOW_MS`：急涨急跌窗口，默认 `60000`，可选。
- `MARKET_SENTINEL_ABSOLUTE_MOVE_THRESHOLD`：持仓或日内绝对涨跌幅红线，默认 `0.05`，可选。
- `MARKET_SENTINEL_PREVIOUS_HIGH_BREAKOUT`：是否启用突破前高红线，默认 `true` 或由策略配置显式开启，可选。
- `SILENT_PATROL_SLOT_MINUTES`：链式巡航显式北京时间槽位，默认来自 `daily-alarm-list.md`，可选。
- `FEISHU_NOTIFY`：是否开启飞书外部主动推送，默认 `false`，可选。
- `BRAIN_PROVIDER`：固定报告和红线研判所用模型 provider，默认可为 mock 或显式配置，必需于真实研判模式。
- `PAPER_TRADING_ENABLED`：模拟盘操作建议和纸面成交入口，默认 `true`，可选。
- `LIVE_TRADING_ENABLED`：真实交易开关，默认 `false`，本方案必须保持关闭。

### Secrets

- 是否需要密钥：需要飞书和真实模型 provider 时需要；纯 mock / 本地验证不需要。
- 密钥来源：环境变量、本机密钥管理或部署平台 secret manager。
- 禁止写入仓库的内容：`FEISHU_APP_SECRET`、模型 API key、broker 凭据、真实账户号、token、cookie、个人身份信息和 `.env`。

## Error Handling

- 腾讯行情请求失败时记录 provider 错误并降级为本地告警，不调用 LLM 编造行情。
- 飞书发送失败时保留本地 file/console 降级通知和可重试审计记录。
- BrainProvider 缺 key、超时或结构化输出不合法时，固定闹钟仍生成可审计失败报告，不执行交易。
- 常驻 daemon 重复启动、任务重入或同一分钟重复触发时必须被锁或去重。
- 持久化冷却账本或巡航状态失败时必须落错误审计；不能因为状态失败而发真实交易动作。
- 配置缺失时优先进入 mock / simulation / local-only 模式，并在启动体检中明确暴露。

## Tests Required

### Unit Tests

- `MarketSentinel`：急涨急跌、持仓 ±5%、止损、突破前高、指数红线、冷却键和 cooldown bypass。
- `AlarmMatrix`：`daily-alarm-list.md` 必报点和周末、月度、年度特殊点的北京时间判断。
- `SilentPatrol`：显式槽位、默认静默、红线激活、nextCheckpoint、activationReason 和 10:30/13:30 必报点不重复巡航。
- `NotificationPushPolicy`：warning/critical 哨兵和指数红线进入飞书，watch 级巡航本地保留。
- 飞书命令解析：状态查询、手动重放闹钟、查询最近红线和报告。

### Integration Tests

- 常驻 daemon 在模拟 provider 下完成 3 秒哨兵、固定闹钟、静默巡航、BrainProvider mock 和 Feishu mock notifier 的全链路。
- 行情 provider 失败、BrainProvider 失败、飞书失败和持久化失败的降级路径。
- 同一分钟重复触发、重复 daemon 启动和任务锁并发保护。
- 账户与交易上下文进入报告，是否触发后续执行由运行配置、执行适配器和审计链路决定。

### Manual Verification

- 以 mock quote 注入 1 分钟急跌、突破前高和持仓 ±5% 场景，确认飞书只收到应推送事件。
- 手动触发 `9:25`、`10:30`、`13:30`、`14:30`、`15:00`、`20:30`、`21:00` 节点，确认报告内容、审计和禁止动作。
- 在飞书中查询当前值守状态、最近红线、最近报告和手动重放节点。
- 验证未配置真实交易时不会访问 broker，也不会写入真实交易参数。

## Acceptance Criteria

- `npm start` 或明确的值守入口可同时启动飞书对话、3 秒哨兵、闹钟矩阵和链式巡航，按配置运行。
- 工作日必报点按 `daily-alarm-list.md` 推送到飞书，链式巡航点默认静默且异常时可解释激活。
- 哨兵普通轮询不消耗 token；只有固定闹钟、红线或用户飞书请求才调用 BrainProvider。
- warning/critical 红线能进入飞书，watch 级噪声不刷屏，critical 事件保留本地降级通知。
- 每次唤醒、跳过、推送、失败和模拟操作建议都有审计线索。
- 单元和集成测试覆盖哨兵、闹钟、巡航、通知和 Feishu mock 路径。

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

1. 对照 `daily-alarm-list.md` 盘点现有闹钟、巡航、哨兵、飞书入口和 README，形成差距清单。
2. 先补领域层确定性规则：哨兵事件 schema、红线阈值、闹钟矩阵、链式巡航状态和通知推送资格。
3. 再补 app/runtime/infrastructure 装配：腾讯 provider、飞书 notifier、BrainProvider 唤醒、状态持久化和 graceful shutdown。
4. 增加 unit tests 和 mock integration tests，覆盖红线、固定闹钟、静默巡航、飞书推送和错误降级。
5. 更新 README、ops 文档和测试说明，明确按配置运行、执行适配器承接和手动验证方法。

## Notes For Coding Agent

后续实现必须先读取 `AGENTS.md`、项目 README、架构 README、模块地图和目标模块 README。保持领域层纯函数化，所有网络、文件、飞书、模型和未来 broker 适配放在 infrastructure/runtime；按配置运行，不新增真实交易入口；涉及交易、风控、哨兵、通知、审计或持久化的改动必须补测试。

