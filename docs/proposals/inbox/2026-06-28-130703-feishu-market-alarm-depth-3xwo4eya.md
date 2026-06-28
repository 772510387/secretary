# Proposal: 飞书 9:15 盘面告警与观察池深度交互

## Metadata

- proposal_id: `2026-06-28-130703-feishu-market-alarm-depth-3xwo4eya`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:07:03`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-130703-feishu-market-alarm-depth-3xwo4eya.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让 `docs/display/alarm-operation.md` 描述的 9:15/9:25 盘面告警、100 池观察和飞书连续追问能力，在 secretary 中以确定性事实层 + LLM 解释层的方式可落地、可审计、可测试。

## Final Decisions

- 飞书交互必须能读取并追问 9:15/9:25 竞价、市场宽度、涨跌停、一字板、封单额、题材热度、100 池分类、优先级和个股备注等事实。
- 盘面事实由确定性代码、Provider、WatchlistMemoryStore、MarketSentinel、Cerebellum 和本地记忆提供；LLM 可负责解释、归纳、策略推演和自然语言表达。
- 常驻哨兵采用轻量轮询方式，交易时段内按配置周期拉取行情，默认 3 秒级；平时只做数字比对，只有触发红线或用户追问时才唤醒大脑。
- 飞书中的深度追问应通过只读工具或上下文桥接完成，不允许模型凭空编造盘面数据，也不允许通过聊天入口直接改账户、发单或覆盖规则。
- 真实交易继续默认关闭；所有交易相关输出最多是建议草案或模拟盘路径，不能绕过 PolicyEngine、RiskEngine、LiveTradingGate 和审计链路。

## Explicit Non Goals

- 不让 LLM 决定硬规则、风控阈值、仓位限制、T+1、100 股整数或记忆最终写入权限。
- 不把飞书机器人做成不可审计的自由执行入口。

## User Value

- 用户在飞书里收到 9:15/9:25 告警后，可以继续追问“哪些一字板”“封单最大是谁”“AI/机器人方向有哪些高优先级”“100 池里某板块候选有哪些”，得到基于本地事实的回答。
- 系统平时低成本常驻盯盘，只有触发确定性红线时才消耗模型 token，并能把关键触发、研判和通知沉淀为后续复盘依据。

## Scope

### In Scope

- 盘前/竞价/盘中告警事实层：行情快照、市场宽度、涨跌停、封单、一字板、题材热度、资金流、观察池概览。
- 飞书交互层：盘面意图识别、上下文加载、只读工具调用、连续追问和回答溯源。
- 哨兵与闹钟协同：固定 SOP 到点推送，3 秒级哨兵负责红线触发，触发后可唤醒大脑研判。
- 审计与降级：Provider 异常、数据陈旧、模型失败时要有明确降级和可追踪记录。

### Out Of Scope

- 前端大屏、移动端 UI 或复杂可视化系统。
- 新闻全文抓取和复杂外部舆情系统，除非后续 proposal 单独定义。
- 修改已有交易规则、风控规则或账户资金逻辑。

## Module Mapping

### Existing Modules Likely Affected

- `src/domain/cerebellum`：承载固定闹钟、盘中哨兵触发条件、告警红线和任务调度领域模型。
- `src/domain/market`：承载行情快照、指数、竞价、涨跌停、K 线和交易时段相关领域模型。
- `src/domain/memory`：承载观察池、盘面快照、报告和写入权限策略。
- `src/domain/brain`：定义 LLM 输入输出协议，确保模型只做解释和建议草案。
- `src/domain/notification`：定义飞书告警等级、去重、冷却和通知内容结构。
- `src/domain/audit`：记录告警触发、工具调用、模型研判和通知投递的审计事件。
- `src/infrastructure/providers`：适配腾讯行情、板块/题材、资金流等外部数据源。
- `src/infrastructure/scheduler`：运行交易时段内的常驻轮询和固定 SOP。
- `src/app/brain-agent-tools.ts`：提供飞书可调用的只读盘面工具，例如市场概览、观察池查询、竞价封板查询。
- `src/app/agent-planner.ts`：把手动 SOP 和飞书追问接入完整盘面上下文。
- `scripts/dev/feishu-bot.ts`：识别飞书盘面追问意图，并加载观察池、盘面和数据健康上下文。
- `scripts/dev/market-sentinel-daemon.ts`：承载轻量常驻哨兵入口，交易时段内按周期拉取行情并触发红线。
- `docs/display/alarm-operation.md`：作为目标呈现深度的验收参考。
- `docs/ops/feishu-bot.md`：说明飞书交互方式、配置和可追问能力。

### New Modules Or Files Proposed

- `none`：优先扩展现有分层和入口，不为该能力新增独立子系统；若后续发现 watchlist 查询或竞价封板规则膨胀，再拆分为独立 app service。

### README Files To Check Or Update

- `README.md`：若启动命令、默认能力或当前状态变化，需要同步说明。
- `docs/architecture/README.md`：若常驻 daemon、飞书工具层或哨兵职责边界变化，需要同步架构说明。
- `docs/architecture/module-map.md`：若新增模块或职责迁移，需要同步模块地图。
- `docs/ops/feishu-bot.md`：必须说明飞书可追问内容、配置、降级和限制。
- `src/domain/cerebellum/README.md`：若变更哨兵红线或闹钟矩阵职责，需要同步。
- `tests/README.md` 或相关测试目录 README：若新增测试分类或约定，需要同步。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 告警红线、轮询间隔、涨跌幅计算、封单筛选、观察池过滤、去重冷却、数据新鲜度判断都由 TypeScript 确定性代码实现。
- llm_authority: LLM 只解释盘面、归纳题材、生成复盘和自然语言建议，不直接产生最终交易动作。
- infrastructure_boundary: 腾讯行情、板块、资金流、飞书 SDK、模型 SDK、文件系统读写都放在 `src/infrastructure` 或脚本入口适配层，领域层不直接依赖外部 SDK。
- domain_boundary: `src/domain` 只保留市场、哨兵、通知、记忆、风控等可信模型和规则，不写网络请求或文件系统细节。
- auditability: 每次红线触发、工具读取、模型研判、飞书推送、数据降级都应能追踪到时间、数据源、输入和输出。
- simulation_default: 运行模式由配置决定；交易建议可升级为执行提案，并由执行适配器、风控和审计链路承接。

## Core Domain Rules

必须由确定性代码实现的规则：

- 交易时段判断、轮询间隔、任务防重入、告警冷却和重复事件去重。
- 1 分钟急涨急跌、突破前高、持仓股涨幅/跌幅、止损线、封板、一字板、连板等红线计算。
- 观察池筛选条件，包括 priority、bucket、sector、theme、symbol、关键词和数量上限。
- 竞价封单排序、封单额/封单量缺失时的降级标记、数据新鲜度判断。
- 飞书只读工具的参数校验、权限校验和返回结构校验。
- 任何交易意图必须继续经过 PolicyEngine、RiskEngine、LiveTradingGate、OrderManager、BrokerAdapter 和 AuditLog。

## Data Flow

### Inputs

- 腾讯实时行情、盘口、涨跌幅、成交额、买卖盘等数据。
- 板块/题材热度、资金流、指数和市场宽度数据。
- `memory` 中的观察池、持仓、交易流水、报告、历史告警和数据健康记录。
- 固定闹钟 SOP、交易时段配置、告警阈值配置。
- 飞书用户消息和允许用户列表。

### Outputs

- 飞书 9:15/9:25/盘中告警消息。
- 飞书连续追问的自然语言回答和只读工具结果摘要。
- 大脑研判报告、盘面复盘、观察池解释和模拟盘建议草案。
- 结构化日志、告警事件、审计记录和数据健康提示。

### State To Persist

- 当日观察池快照、分类统计、优先级、题材、封单和数据来源时间。
- 哨兵触发事件、告警冷却状态和最近一次通知摘要。
- 大脑研判报告、飞书关键交互摘要和手动 SOP 结果。
- Provider 数据健康、降级原因和异常恢复记录。

### Audit Records

- `sentinel_triggered`：记录触发规则、触发值、阈值、行情时间和 symbols。
- `brain_wakeup_requested`：记录唤醒原因、输入事实摘要和 provider。
- `feishu_notification_sent`：记录接收人、消息类型、告警等级和去重 key。
- `agent_tool_called`：记录工具名、参数、数据快照版本和返回摘要。
- `data_degraded`：记录外部数据源异常、陈旧、缺字段和降级策略。

## Configuration

### Required Config

- `SENTINEL_POLL_INTERVAL_MS`：哨兵轮询间隔，默认值 `3000`，可选。
- `SENTINEL_WAKE_BRAIN`：红线触发后是否唤醒大脑，默认值 `false` 或由启动参数控制，可选。
- `FEISHU_NOTIFY`：是否启用飞书外部推送，默认值 `0`，可选。
- `FEISHU_ALLOWED_USERS`：允许交互的飞书用户列表，默认值为空，启用飞书时必填。
- `BRAIN_PROVIDER`：大脑 provider，默认使用 mock 或现有配置，启用真实研判时必填。
- `MARKET_DATA_STALE_MS`：盘面数据最大可接受陈旧时间，默认值由实现按交易阶段定义，可选。

### Secrets

- 是否需要密钥：启用飞书和真实大脑 provider 时需要。
- 密钥来源：环境变量或本机密钥管理，例如 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`DASHSCOPE_API_KEY`、`OPENAI_API_KEY`。
- 禁止写入仓库的内容：任何 app secret、API key、真实账户、真实交易参数、券商凭证、用户隐私和飞书 token。

## Error Handling

- Provider 超时或失败时，返回部分事实并标记 `data_degraded`，飞书回答必须明确说明缺失或陈旧来源。
- 观察池快照不存在时，飞书返回“当前没有可用观察池快照”，不能编造股票列表。
- LLM provider 失败时，保留确定性告警和事实摘要，跳过解释层或使用 mock 降级。
- 飞书发送失败时，写入通知失败日志并保留告警事件，不能丢失触发记录。
- 哨兵循环内单次异常不得杀死进程，应记录错误并在下个 tick 继续。
- 数据字段缺失时应按 `unknown` 或显式缺失处理，不能把缺失值当 0 参与封单排序。

## Tests Required

### Unit Tests

- 哨兵红线计算：1 分钟急跌、急涨、突破前高、持仓涨幅/跌幅和冷却去重。
- 观察池查询：按 priority、bucket、sector、theme、symbol、关键词和 limit 过滤排序。
- 竞价封板：一字板识别、封单额排序、连板天数、缺字段降级。
- 飞书盘面意图识别：盘前、竞价、观察池、一字板、封单、题材、板块、市场宽度等关键词。
- 只读工具参数校验：非法参数拒绝、结果不带副作用、不产生交易 intent。
- 手动 SOP 上下文注入：市场阶段、池子概览、数据健康和持仓资金流必须进入大脑输入。

### Integration Tests

- fake Provider + fake WatchlistMemoryStore + fake Feishu notifier，验证从哨兵触发到飞书通知的完整链路。
- fake 飞书消息追问“9:15 一字板有哪些”，验证工具调用、事实读取、自然语言回答和审计记录。
- Provider 部分失败时，验证告警仍可降级推送且回答包含数据健康提示。

### Manual Verification

- 使用 `npm run sentinel:dev -- --live --wake-brain` 在交易时段或 mock 行情下验证 3 秒级哨兵触发。
- 使用 `npm run cerebellum:dev -- --fire <节点>` 验证 9:15/9:25 SOP 推送。
- 在飞书私聊中追问观察池、封单、一字板、题材和个股，确认回答基于本地事实而非幻觉。
- 检查 `memory`、日志和审计记录是否保留触发、研判和通知线索。

## Acceptance Criteria

- 飞书收到 9:15/9:25 告警后，用户可以继续追问观察池、封单、一字板、题材和板块，回答必须基于可追踪事实。
- 哨兵在交易时段内可按默认 3 秒级轮询运行，平时不消耗模型 token，只有红线触发或用户追问时进入模型层。
- 当观察池或 Provider 数据缺失时，系统明确提示缺失/降级，不编造股票、封单额或题材。
- 所有确定性规则有单元测试覆盖，飞书追问和哨兵触发有集成或手动验证路径。
- LLM 不直接改账户、不发单、不覆盖规则文件，真实交易能力保持关闭。

## Dependencies

### Depends On Other Proposals

- `none`

### Blocks Other Proposals

- `unknown`

### Potential Conflicts

- `unknown`

## Open Questions

- 飞书最终呈现是否需要升级为卡片消息，还是继续优先使用文本消息加结构化摘要。
- 竞价阶段封单额、封单量和一字板字段在不同 Provider 不完整时，是否需要引入统一置信度评分。
- 是否需要把 9:15/9:25 的展示字段固化为 schema，供未来前端或大屏复用。

## Suggested Implementation Order

1. 固化事实层契约：定义市场概览、观察池查询、竞价封板、数据健康和告警事件的结构化输出。
2. 扩展哨兵和闹钟链路：确保交易时段轮询、红线触发、SOP 到点推送和降级逻辑都可测试。
3. 扩展飞书交互：增加盘面意图识别、只读工具、上下文加载和连续追问能力。
4. 接入审计和记忆：记录触发、工具读取、模型研判、通知投递和降级原因。
5. 补齐单元、集成和手动验证，并同步 README/ops 文档。

## Notes For Coding Agent

后续实现必须先读 `AGENTS.md`、`README.md`、`docs/architecture/README.md` 和 `docs/architecture/module-map.md`。保持 TypeScript 优先，领域层不直接调用网络、文件系统、模型 SDK 或飞书 SDK；所有外部数据源和通知放在基础设施或入口适配层。LLM 可以解释事实和生成建议草案，不能进入确定性决策链，也不能触发真实交易。

