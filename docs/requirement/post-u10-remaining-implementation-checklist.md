# Post-U10 剩余能力实现清单

生成日期：2026-06-15

本清单用于承接 `unimplemented-capability-checklist.md` 的 U1-U10。当前项目已经完成或评估过行情、记忆、工具边界、闹钟上下文、通知、真实 BrainProvider、TradingAgents-CN 子进程 runner、paper-only ManualConfirmBroker 和实盘预备边界。

这份清单只列后续仍值得工程化的能力，不重新安排已经完成的 U1-U10。默认继续保持模拟盘和辅助决策定位，不实现自动实盘交易。

## 0. 当前基线

已具备：

- PaperBroker、PolicyEngine、RiskEngine、Portfolio、审计日志和基础 storage。
- Tencent 实时行情和日 K 历史行情 provider。
- MarketSentinel 单次检查和 scheduler runner 的受控触发。
- 固定北京时间闹钟上下文包。
- MockBrainProvider、DashScopeQwenProvider、OpenAIProvider、报告生成和研究报告写入。
- TradingAgents-CN fake subprocess runner 适配。
- MemoryWritePolicy、MemoryRegistry、人工提案模型和 ManualConfirmBroker paper-only 门禁。
- Console/file notifier、R4-1 WebhookNotifier 和 R4-3 通知路由/升级策略。
- R3-2 随时看盘 app 用例，支持 mock/注入 QuoteProvider、HistoryProvider 和 MemoryRegistry 组装指定标的或传入标的集合的盘面摘要。
- R3-3 Webhook 入口 `accessAudit`、requestId 幂等去重和最小限流。
- R5-1/R5-2 已实现自选股三类池、人工 seed/import 文件存储和 high priority 自选股盘中扫描；R5-3 已形成题材热度确定性模型 ADR。
- R7-1/R7-2 已实现 MemoryRegistry 时间过滤和复盘 metadata 标准化；R7-3 已形成向量语义检索 ADR。
- R9-1/R9-2/R9-3 已实现 LiveTradingGate、账户 allowlist schema/storage 和全局/账户/标的 kill switch 状态；只做非交易性准入检查和审计，不接真实 broker、不下单。
- R10-1/R10-2/R10-3 已实现 `LiveBrokerAdapter` contract、`FakeLiveBrokerAdapter`、`FakeReadOnlyBroker` 和 `QmtFakeSubprocessBridge` fake 协议；R10-4 已更新 PTrade 接入 ADR。当前仍不接真实 broker、不写账号、不下单。

仍未具备或只停留在设计阶段：

- 真实常驻 daemon 的启动、健康检查和运行态观测。
- R2-1/R2-2/R2-3 已补齐完整全天闹钟矩阵、10 分钟静默巡航和闹钟 SOP 上下文模板；R5-2 已补 high priority 自选股扫描；R6-1/R6-2/R6-3 已补指数快照 provider、系统性风险雷达和量价异常领域计算。
- R3-1 已实现 Webhook 请求 schema 和安全处理入口，R3-2 已实现随时看盘 app 用例，R3-3 已实现入口审计摘要、幂等去重和最小限流；仍未实现真实 HTTP server、API 入口、微信或外部 webhook 通知。
- 题材热度真实 provider 接入，以及指数/量价雷达与运行态、通知路由的进一步组合。
- 语义向量检索实现仍未接入；当前只完成 ADR 评估，默认继续关键词检索。
- GeminiProvider 仍只停留在 structured output 兼容性评估阶段；Tushare/Akshare 仍只完成 provider 接入评估，尚未实现真实数据 provider。
- 对账系统、真实 broker adapter、真实只读 smoke 和小额人工 smoke。
- Manual approval 的持久化、操作者会话和未来 UI/API 审核入口。
- 真实 broker、自动实盘下单。

## 1. 全局边界

后续每个任务都必须遵守：

- 默认不联网，真实网络 smoke 必须显式环境变量启用。
- 不写 API key、券商账号、交易密码或真实交易参数。
- 不接真实 broker，除非用户明确进入未来实盘专项阶段。
- 不实现自动实盘买入。
- LLM 只能输出结构化建议或工具请求，不能拥有 `canExecute=true`。
- 交易类输出只能进入人工提案或 paper delegate。
- 任何资金、持仓、订单、提案、审批、风控、记忆写入都必须可审计。
- domain 层不直接访问网络、文件系统、模型 SDK 或券商 SDK。
- 涉及文件写入继续使用 storage 层的原子写入、追加写入或备份策略。

## 2. 推荐推进顺序

优先顺序：

1. R0 状态校准，把已完成和剩余项同步到文档。
2. R1 运行态常驻底座，先让系统能安全地跑起来和停下来。
3. R2 补全闹钟矩阵和静默巡航，让小脑任务更贴近原始需求。
4. R3 Webhook/API 入口，让用户请求和系统事件能进入后端。
5. R4 外部通知通道，在安全脱敏后再接 webhook/微信。
6. R5 自选股和题材雷达，补“今天看什么”。
7. R6 指数和放量雷达，补系统性风险和量价异常。
8. R7 记忆增强，先补时间维度，再评估向量检索。
9. R8 补充 provider，按需要接 OpenAI/Gemini/Tushare/Akshare。
10. R11-R12 继续补非交易性实盘底座：对账、对账失败降级、审批持久化和审批入口。
11. R12 补人工审批持久化和入口。
12. R13 最后才设计只读或小额人工 smoke，不做自动实盘。

如果当前目标是“系统能长期值守”，先做 R1、R2、R3。

如果当前目标是“更会看盘”，先做 R5、R6、R7。

如果当前目标是“未来实盘准备”，R9 和 R10 已完成第一版，下一步先做 R11、R12，仍不接真实 broker。

## 3. R0 状态校准和发布前审计

状态：已完成，2026-06-15。后续不要重复执行，除非 U1-U10 状态再次发生变化。

目标：

- 把 U1-U10 的完成状态、验证命令和剩余风险同步到文档。
- 避免后续 AI 重复实现已经完成的模块。

建议范围：

- `docs/requirement`
- `docs/architecture`
- 相关模块 README

验收：

- `unimplemented-capability-checklist.md` 不再把 U1-U10 表述成待实现。
- 新增剩余能力清单入口。
- README 中的当前状态不误导。
- 不改业务代码。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R0。
只修正文档状态，不改业务代码。
同步 U1-U10 已完成或已评估的状态，并列出剩余能力入口。
运行 npm run check:docs。
```

## 4. R1 运行态常驻底座

### R1-1 MarketSentinel daemon 开发入口

状态：已完成，2026-06-15。默认 mock task，只写 scheduler 审计 metadata，不联网、不调用真实 LLM、不接 broker。

目标：

- 增加受控开发命令，能启动一次本地哨兵常驻循环。
- 默认使用 mock 或 paper 依赖，不接真实 broker。

建议范围：

- `src/runtime`
- `src/infrastructure/scheduler`
- `src/interfaces/cli`
- `scripts/dev`
- `tests/integration`

验收：

- 能通过开发脚本启动和停止哨兵。
- 支持优雅关闭、重复启动保护、运行中错误审计。
- 测试使用 fake timer 或短间隔，不启动真实长驻进程。
- 默认不联网，不调用真实 LLM，不接 broker。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R1-1。
实现 MarketSentinel daemon 的开发入口，默认 mock/paper，不联网、不接真实 broker。
补集成测试覆盖启动、停止、重复启动和错误审计。
运行 npm run typecheck 和 npm test。
```

### R1-2 Runtime health 和 heartbeat

状态：已完成，2026-06-15。`MarketSentinelDaemon` 会写入 `memory/logs/runtime-health.json` 和 `memory/logs/heartbeat-YYYY-MM-DD.jsonl`，只记录状态、时间、必要 metadata 和脱敏错误摘要。

目标：

- 为常驻任务提供最小健康状态、heartbeat 和最近错误摘要。

建议范围：

- `src/runtime`
- `src/infrastructure/storage`
- `memory/logs`
- `tests/unit`
- `tests/integration`

验收：

- 运行态能写入 heartbeat metadata。
- health 不包含密钥、账号或完整正文。
- 任务异常能记录最后错误类型和时间。
- 停止后状态明确。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R1-2。
实现 runtime health 和 heartbeat 元数据记录。
只记录状态和错误摘要，不记录密钥、账号或完整研究正文。
补测试并更新 runtime README。
运行 npm run typecheck 和 npm test。
```

## 5. R2 完整闹钟矩阵和静默巡航

### R2-1 扩展全天固定闹钟矩阵

状态：已完成，2026-06-15。已覆盖 08:00 到 21:00、00:00、周六 10:00、月末 20:00 和 12-31 20:00；只生成任务和上下文包，不启动 daemon、不联网、不接 broker。

目标：

- 把原始需求中的更完整北京时间闹钟补成可测试矩阵。

建议补充时间点：

- 08:00 数据预热。
- 08:15 隔夜消息整理。
- 08:30 盘前计划。
- 09:15 集合竞价观察。
- 09:25 开盘前确认。
- 10:00 早盘第一次回顾。
- 11:30 午间回顾。
- 14:00 午后风险扫描。
- 14:30 尾盘预案。
- 15:00 收盘快照。
- 15:30 盘后扩展复盘。
- 20:30 深度复盘。
- 21:00 次日观察池整理。
- 00:00 每日自省。
- 周六 10:00 周复盘。
- 月末 20:00 月复盘。
- 12-31 20:00 年复盘。

验收：

- 所有时间使用北京时间。
- 周、月末、年末判断有测试。
- 每个闹钟都有稳定 `alarmId`、任务类型、上下文包构造规则。
- 不启动真实 daemon，不联网，不接 broker。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R2-1。
扩展小脑全天北京时间闹钟矩阵，覆盖 08:00 到 21:00、00:00、周/月/年复盘。
只生成任务和上下文包，不启动真实 daemon，不联网，不接 broker。
补单元测试并更新 cerebellum/runtime README。
运行 npm run typecheck 和 npm test。
```

### R2-2 10 分钟静默巡航

状态：已完成，2026-06-15。已实现盘中 10 分钟静默巡航任务对象、北京时间触发条件、无异常静默、异常待处理事件、冷却去重和 metadata 脱敏；不调用 BrainProvider、不接 broker。

目标：

- 实现盘中 10 分钟静默巡航的任务对象和触发条件。
- 无异常时不唤醒大脑。

验收：

- 交易时段内按北京时间生成巡航任务。
- 无异常时只写 metadata 或保持静默。
- 异常时输出待处理事件，不直接调用 broker。
- 冷却和去重有测试。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R2-2。
实现 10 分钟静默巡航任务对象和异常触发规则。
无异常不唤醒 BrainProvider，有异常只生成事件和审计元数据，不接 broker。
补测试并更新 scheduler/cerebellum README。
运行 npm run typecheck 和 npm test。
```

### R2-3 闹钟 SOP 上下文模板

状态：已完成，2026-06-15。已为每个固定闹钟生成确定性 SOP 上下文模板，包含 `objective`、`requiredInputs`、`allowedActions`、`forbiddenActions` 和安全约束；不塞示例股票、不制造虚假持仓、不包含密钥或账号正文。

目标：

- 为不同闹钟生成确定性 SOP 上下文包。
- SOP 只列操作要求，不塞示例股票，不制造虚假持仓。

验收：

- 每个闹钟有 `objective`、`requiredInputs`、`allowedActions`、`forbiddenActions`。
- 上下文只包含路径、摘要、元数据和安全约束。
- 不包含密钥、账号和完整敏感正文。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R2-3。
为小脑闹钟补确定性 SOP 上下文模板。
不要写示例股票，不要假造持仓，只输出操作要求、输入路径和安全边界。
补测试并更新 cerebellum README。
运行 npm run typecheck 和 npm test。
```

## 6. R3 Webhook/API 和随时看盘

### R3-1 安全 Webhook 请求校验

状态：已完成，2026-06-15。已实现 `webhookRequestSchema` 和 `handleWebhookRequest()` 纯函数入口，覆盖最小 bearer token 鉴权、schema 校验、requestId 去重、限流、危险 payload 拒绝、ToolRuntime 非执行计划和 metadata-only 审计；不启动 HTTP server、不调用 BrainProvider、不接 broker。

目标：

- 实现后端 Webhook 请求 schema 和处理入口。

建议事件：

- `user_message`
- `market_event`
- `manual_confirm`
- `system_event`

验收：

- 请求必须通过 schema 校验。
- 非法工具、读密钥、直接下单、写账户请求被拒绝并写审计。
- Webhook 只能生成任务、报告、提案或通知，不直接触发 broker。
- 有鉴权、限流或最小 token 校验设计。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R3-1。
实现 Webhook 请求 schema 和安全处理入口。
禁止直接下单、写账户、读密钥；交易类请求只能生成提案。
补测试并更新 interfaces/webhook README。
运行 npm run typecheck 和 npm test。
```

### R3-2 随时看盘 use case

状态：已完成，2026-06-15。已实现 `runWatchMarketOnce()`，通过 mock/注入的 QuoteProvider、HistoryProvider 和 MemoryRegistry 组装上下文，返回结构化摘要、非执行报告草稿和 metadata-only 审计；默认不联网、不调用真实 LLM、不写账户、不下单、不接 broker。当前大盘查询按传入标的集合聚合，尚未接指数 provider。

目标：

- 支持用户主动查询“现在盘面怎么样”或指定股票快照。

验收：

- 使用 QuoteProvider/HistoryProvider/MemoryRegistry 组装上下文。
- 默认 mock provider 测试，不联网。
- 可返回结构化摘要和报告草稿。
- 不写账户、不下单、不接 broker。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R3-2。
实现随时看盘 use case，支持大盘和指定 A 股标的摘要。
默认 mock provider，不联网，不调用真实 LLM，不接 broker。
补测试并更新 app/interfaces README。
运行 npm run typecheck 和 npm test。
```

### R3-3 API/Webhook 审计和限流

状态：已完成，2026-06-15。已在 Webhook 纯函数入口返回 `accessAudit`，显式记录 `auditId`、`requestId`、`source`、`eventType`、`result`、重复请求标记、限流标记和拒绝原因；重放 requestId 返回 `skipped_duplicate`，限流失败返回 `rate_limited` 并给出 `errorCode`、`rateLimitKey` 和 `retryAfterMs`。仍未启动真实 HTTP/API server。

目标：

- 给外部入口补最小审计、重复请求防护和限流。

验收：

- 记录 requestId、source、eventType、result、auditId。
- 不记录 secret header、token 或完整用户敏感正文。
- 重放请求可识别。
- 限流失败返回明确错误。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R3-3。
为 Webhook/API 入口补审计、幂等 requestId 和最小限流。
不记录 secret header、token 或完整敏感正文。
补测试并更新 interfaces README。
运行 npm run typecheck 和 npm test。
```

## 7. R4 外部通知通道

### R4-1 WebhookNotifier

状态：已完成，2026-06-15。已实现 infrastructure 层 `WebhookNotifier`，默认测试使用 mock fetch，不联网；覆盖成功发送、超时、429、401/403、5xx、坏 JSON、`{ ok: false }` 坏响应和输出脱敏。真实 smoke 只有在 `WEBHOOK_NOTIFIER_NETWORK=1` 且提供 `WEBHOOK_NOTIFIER_URL` 时才运行。

目标：

- 在现有 NotificationEvent 基础上实现外部 webhook notifier。

验收：

- 默认 mock fetch 测试，不联网。
- 支持超时、429、401/403、5xx、坏响应。
- 输出脱敏。
- 真实 smoke 需要显式环境变量。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R4-1。
实现 WebhookNotifier，默认 mock fetch，不联网。
覆盖超时、429、401/403、5xx、坏响应和脱敏。
补测试并更新 notification/infrastructure README。
运行 npm run typecheck 和 npm test。
```

### R4-2 微信通知 ADR 和最小接口

状态：已完成，2026-06-15。已新增 `docs/architecture/decision-records/2026-06-15-wechat-notification-design.md`，明确企业微信机器人、企业微信应用消息、微信公众号模板消息和 Server 酱类服务的候选边界；只定义最小接口契约、鉴权、脱敏、限流、失败降级和测试策略，不接真实微信、不写 token、不联网。

目标：

- 先做微信通知设计和接口，不急于接真实外部系统。

验收：

- 明确企业微信/公众号/Server 酱等候选边界。
- 不写 token，不联网。
- 设计消息级别、频率、失败降级和脱敏。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R4-2。
只写微信通知 ADR 和最小接口设计，不接真实微信，不写 token。
重点说明鉴权、脱敏、限流、失败降级和测试策略。
运行 npm run check:docs。
```

### R4-3 通知路由和升级策略

状态：已完成，2026-06-15。已实现 `planNotificationRoute()` 和 infrastructure 层 `NotificationRouter`，支持按 `info`、`watch`、`warning`、`critical` 配置路由；默认只启用 `console`/`file`，`webhook`/`wechat` 外部通道必须显式开启。critical 会生成审计事件并要求 `auditSink` 先写审计，缺审计 sink 时拒绝静默发送。

目标：

- 按通知级别选择 console/file/webhook/未来微信通道。

验收：

- `info`、`warning`、`critical` 路由可配置。
- 同类告警支持冷却。
- critical 写审计并走多通道。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R4-3。
实现通知路由和升级策略，默认只启用 console/file。
critical 必须写审计，外部通道默认关闭。
补测试并更新 notification README。
运行 npm run typecheck 和 npm test。
```

## 8. R5 自选股池和题材雷达

### R5-1 Watchlist 领域模型和存储

状态：已完成，2026-06-16。已实现 `WatchlistEntry`/`WatchlistSnapshot` 领域模型和 `WatchlistMemoryStore` 文件存储，支持 `watchlist_today`、`watchlist_long_term`、`potential_stocks`，默认只支持人工 seed/import，不联网、不调用 LLM、不接 broker。

目标：

- 实现今日关注池、长期自选池和潜力股池。

验收：

- 支持 `watchlist_today`、`watchlist_long_term`、`potential_stocks`。
- 每条记录包含 symbol、name、priority、reason、source、updatedAt。
- 先支持人工 seed/import，不默认 web search。
- storage 层负责落盘，domain 不碰文件系统。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R5-1。
实现 Watchlist 领域模型和文件存储，支持今日关注、长期自选和潜力股。
先支持人工 seed/import，不联网，不调用 LLM，不接 broker。
补测试并更新 market/memory README。
运行 npm run typecheck 和 npm test。
```

### R5-2 自选股盘中扫描

状态：已完成，2026-06-16。`MarketSentinel` 已支持 high priority 自选股扫描，可根据日内涨跌幅和接近观察价生成事件，并返回 metadata-only 审计事件草稿；只生成事件/后续通知或研究任务输入，不接 broker、不下单。

目标：

- 让 MarketSentinel 扫描持仓和高优先级自选股。

验收：

- high priority 自选股可进入扫描列表。
- 跌幅、涨幅、接近观察价等条件能生成事件。
- 冷却、去重和审计有测试。
- 只生成 alert/research/proposal，不下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R5-2。
扩展 MarketSentinel 支持高优先级自选股扫描。
命中后只生成事件、通知或研究任务，不接 broker。
补测试并更新 cerebellum/market README。
运行 npm run typecheck 和 npm test。
```

### R5-3 题材热度模型评估

状态：已完成，2026-06-16。已新增 `docs/architecture/decision-records/2026-06-16-theme-heat-model-evaluation.md`，明确确定性评分、数据源、字段、缓存、失败降级和 LLM 边界；未实现真实网络抓取。

目标：

- 先设计题材/板块热度如何确定性计算，避免直接依赖 LLM 幻觉。

验收：

- 形成 ADR。
- 明确数据源、字段、缓存、失败降级。
- 明确 LLM 只能解释热度，不直接决定写入规则或下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R5-3。
只做题材热度模型 ADR，不实现真实网络抓取。
明确数据源、缓存、失败降级和 LLM 边界。
运行 npm run check:docs。
```

## 9. R6 指数雷达和放量雷达

### R6-1 IndexSnapshot provider

状态：已完成，2026-06-16。已实现 `IndexSnapshot`、`TencentIndexProvider` 和 mock fetch 集成测试，覆盖上证指数、深成指、创业板指、科创 50、HTTP 失败、空响应、坏数据和超时；科创 50 固定仅作指数观察，不改变主板交易限制，不接 broker。

目标：

- 实现指数快照统一模型和 provider。

建议指数：

- 上证指数。
- 深成指。
- 创业板指。
- 科创 50 只作为指数观察，不代表允许交易科创板股票。

验收：

- mock fetch 测试解析指数快照。
- 处理 HTTP 失败、空响应、坏数据、超时。
- 不改变主板交易限制。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R6-1。
实现 IndexSnapshot 模型和指数 provider，默认 mock fetch，不联网。
覆盖 HTTP 失败、空响应、坏数据和超时。
不改变主板交易限制，不接 broker。
运行 npm run typecheck 和 npm test。
```

### R6-2 系统性风险雷达

状态：已完成，2026-06-16。已实现 `detectIndexSystemicRisk()`，支持 `lookbackMs` 和 `lookbackCount`，基于确定性阈值生成 `MarketAnomaly` 和 `NotificationEvent` 草稿；只输出事件和通知，不调用真实 LLM、不接 broker、不下单。

目标：

- 用指数快照检测大盘急跌、急涨或系统性风险。

验收：

- 支持 1 分钟、5 分钟或最近 N 次快照对比。
- 阈值来自配置或确定性参数。
- 命中后生成 `MarketAnomaly` 和通知，不下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R6-2。
实现指数系统性风险雷达，基于确定性阈值生成 MarketAnomaly。
只生成事件和通知，不调用真实 LLM，不接 broker。
补测试并更新 market/cerebellum README。
运行 npm run typecheck 和 npm test。
```

### R6-3 放量和量价异常雷达

状态：已完成，2026-06-16。已实现 `calculateKlineVolumePriceSignal()` 和 `calculateQuoteVolumePriceSignal()`，指标计算在 domain 层纯函数完成，覆盖量价齐升、爆量滞涨、停牌/无量、缺字段、低流动性和非法参数；Provider 仍只负责取数转换，不生成订单。

目标：

- 根据快照或 K 线计算相对成交量、爆量滞涨、量价齐升等基础标签。

验收：

- 指标计算在 domain 层纯函数完成。
- Provider 只负责取数和转换。
- 有单元测试覆盖正常、缺字段、停牌、低流动性。
- 不生成订单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R6-3。
实现放量和量价异常雷达的领域计算。
使用纯函数和 mock 数据测试，不联网，不调用 LLM，不接 broker。
运行 npm run typecheck 和 npm test。
```

## 10. R7 记忆增强

### R7-1 MemoryRegistry 时间过滤

状态：已完成，2026-06-16。`MemoryRegistry.listDocuments()`、`search()` 和 `recent()` 已支持 `from`、`to`、`limit`、`category`/`categories`；搜索结果直接返回 `path`、`summary`、`updatedAt` 和 metadata，并继续脱敏密钥、token、运行态敏感正文和完整审计正文。

目标：

- 在现有关键词和最近记忆检索上增加时间范围过滤。

验收：

- 支持 `from`、`to`、`limit`、`category`。
- 返回 path、summary、updatedAt 和 metadata。
- 不返回密钥、运行态敏感正文或完整审计正文。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R7-1。
给 MemoryRegistry 增加时间范围过滤。
不引入向量库，不联网，不调用 LLM。
补集成测试并更新 memory README。
运行 npm run typecheck 和 npm test。
```

### R7-2 复盘元数据标准化

状态：已完成，2026-06-16。报告生成已写入标准化复盘 metadata：`period`、`symbols`、`marketSummary`、`decisionSummary`、`riskNotes`、`linkedAuditIds`；正文仍保存在 `contentMarkdown`，`MemoryRegistry.recent({ category: "reports" })` 只抽 metadata，不返回完整正文。

目标：

- 标准化日、周、月、年复盘报告的 metadata。

验收：

- 支持 period、symbols、marketSummary、decisionSummary、riskNotes、linkedAuditIds。
- 报告正文和 metadata 分离。
- 可被 MemoryRegistry 最近 N 条读取。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R7-2。
标准化日/周/月/年复盘报告 metadata。
正文和 metadata 分离，便于 MemoryRegistry 检索。
补测试并更新 memory/reports README。
运行 npm run typecheck 和 npm test。
```

### R7-3 向量语义检索 ADR

状态：已完成，2026-06-16。已新增 `docs/architecture/decision-records/2026-06-16-vector-semantic-memory-search-evaluation.md`；结论为第一阶段继续使用关键词检索和文件索引，不引入大型向量库，未来 embedding 必须脱敏、缓存、可重建并可降级。

目标：

- 只评估向量检索方案，不马上引入大型向量库。

验收：

- 明确本地 embedding、远程 embedding、SQLite/文件索引、向量库的取舍。
- 明确隐私、费用、缓存、重建、失败降级。
- 明确第一阶段仍保留关键词检索。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R7-3。
只做向量语义检索 ADR，不实现大型向量库。
评估本地/远程 embedding、索引重建、隐私、费用和失败降级。
运行 npm run check:docs。
```

## 11. R8 补充 provider

### R8-1 OpenAIProvider

状态：已完成，2026-06-16。已实现 `OpenAIProvider`，使用官方 Chat Completions JSON Mode，默认通过 mock fetch 测试，不写 API key、不联网；输出必须经过 `validateBrainOutput()`，请求不发送 `tools` 字段，`ToolPermission.canExecute=true` 会在本地被拒绝。

目标：

- 在 DashScope 稳定后实现 OpenAIProvider 作为质量基准。

验收：

- 使用官方 API 设计，输出必须经过本地 schema 校验。
- 默认 mock fetch，不联网，不写 API key。
- 覆盖缺 key、401/403、429、5xx、超时、坏 JSON、坏 schema。
- 不允许模型工具执行。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R8-1。
实现 OpenAIProvider，默认 mock fetch，不写 API key，不联网。
输出必须经过 validateBrainOutput，不允许工具执行。
覆盖缺 key、401/403、429、5xx、超时、坏 JSON 和坏 schema。
运行 npm run typecheck 和 npm test。
```

### R8-2 GeminiProvider 评估或实现

状态：已完成评估，2026-06-16。已新增 `docs/architecture/decision-records/2026-06-16-gemini-provider-structured-output-evaluation.md`；结论是 Gemini structured output 可兼容窄化后的 brain 输出，但当前不实现 `GeminiProvider`，后续必须先处理 JSON Schema 子集、错误映射、限流和禁用工具能力。

目标：

- 评估 Gemini structured output 对当前 schema 的兼容性。

验收：

- 先形成评估文档。
- 如果实现，必须本地 schema 校验。
- 默认 mock fetch，不联网，不写 API key。

交给 AI 的提示词：

```text
请评估 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R8-2。
先判断 Gemini structured output 是否兼容当前 brain schema。
默认只写 ADR；如确需实现，必须 mock fetch、不写 key、不联网。
```

### R8-3 Tushare/Akshare provider 评估

状态：已完成评估，2026-06-16。已新增 `docs/architecture/decision-records/2026-06-16-tushare-akshare-provider-evaluation.md`；当前不实现 `TushareProvider` 或 `AkShareProvider`，后续必须先明确数据许可、频率限制、字段映射、缓存、失败降级和 token 管理边界。

目标：

- 评估补充市场、财务、板块数据 provider。

验收：

- 明确数据许可、频率限制、字段映射、缓存和失败降级。
- 不写 token。
- 不把真实网络设为默认测试。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R8-3。
只评估 Tushare/Akshare provider 接入，不写 token，不联网。
明确数据许可、频率限制、字段映射、缓存和失败降级。
运行 npm run check:docs。
```

## 12. R9 实盘非交易性安全底座

### R9-1 LiveTradingGate

状态：已完成，2026-06-16。已实现领域层 `evaluateLiveTradingGate()` 和 broker 侧 `LiveTradingGate` 封装；`LIVE_TRADING=true` 仍不足以通过，必须同时检查 trading mode、broker provider、账户 allowlist、人工确认、PolicyEngine、RiskEngine、kill switch 和审计可写；只写 metadata 审计，不接真实 broker、不下单。

目标：

- 实现未来 live delegate 前的准入矩阵，但不接真实 broker。

验收：

- `LIVE_TRADING=true` 仍不足以通过。
- 必须检查 trading mode、broker provider、账户 allowlist、人工确认、PolicyEngine、RiskEngine、kill switch、审计可写。
- 缺任一条件都拒绝并写审计 metadata。
- 不下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R9-1。
实现 LiveTradingGate 准入矩阵，但不接真实 broker，不下单。
LIVE_TRADING=true 仍不足以通过，必须检查 allowlist、人工确认、风控、审计和 kill switch。
补测试并更新 trading/risk/broker README。
运行 npm run typecheck 和 npm test。
```

### R9-2 账户 allowlist schema

状态：已完成，2026-06-16。已实现 `LiveAccountAllowlist` schema、通配拒绝、账户标识脱敏、缺 allowlist 默认拒绝，以及 `LiveTradingSafetyStore` 文件存储和 metadata-only 审计；未写真实账号。

目标：

- 增加未来实盘账户白名单模型和存储策略。

验收：

- 不允许通配。
- 账户标识脱敏展示。
- 缺 allowlist 默认拒绝。
- 不写真实账号。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R9-2。
实现账户 allowlist schema 和校验，不写真实账号，不允许通配。
缺 allowlist 默认拒绝，展示时必须脱敏。
补测试并更新 config/broker README。
运行 npm run typecheck 和 npm test。
```

### R9-3 应急停机状态

状态：已完成，2026-06-16。已实现全局、账户、标的三级 `KillSwitchState`，支持 `readOnly`、`cancelOnly`、`disabled`；状态通过 `LiveTradingSafetyStore` 持久化并写审计，触发后可阻止新增委托或全部 broker delegate；不接真实 broker。

目标：

- 实现全局、账户、标的三级 kill switch 状态。

验收：

- 支持 `readOnly`、`cancelOnly`、`disabled`。
- 状态持久化并写审计。
- 触发后阻止新增买入或全部 broker delegate。
- 不接真实 broker。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R9-3。
实现全局/账户/标的 kill switch 状态，支持 readOnly、cancelOnly、disabled。
状态持久化并写审计，不接真实 broker。
补测试并更新 risk/broker README。
运行 npm run typecheck 和 npm test。
```

## 13. R10 Broker 抽象和 fake/read-only delegate

### R10-1 LiveBrokerAdapter contract

状态：已完成，2026-06-16。已定义 `LiveBrokerAdapter` 最小 contract，覆盖账户/资金/持仓/委托/成交查询、提交委托和撤单；`submitOrder()` 和 `cancelOrder()` 必须显式接收 `LiveTradingGateResult`。`FakeLiveBrokerAdapter` 已覆盖 accepted、rejected、unknown、timeout 和重复 requestId 幂等返回；不接真实 broker。

目标：

- 定义未来 live broker 的最小统一接口和 contract test。

验收：

- 接口覆盖查询现金、持仓、委托、成交、提交委托、撤单。
- 所有提交委托前必须要求 LiveTradingGateResult。
- fake adapter 覆盖成功、拒绝、未知、超时、重复请求。
- 不接真实 broker。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R10-1。
定义 LiveBrokerAdapter contract 和 fake adapter 测试。
提交委托必须要求 LiveTradingGateResult，不接真实 broker。
补测试并更新 broker README。
运行 npm run typecheck 和 npm test。
```

### R10-2 ReadOnlyBroker

状态：已完成，2026-06-16。已实现 `ReadOnlyBroker` 抽象和 `FakeReadOnlyBroker`，只暴露账户、资金、持仓、委托和成交查询；类上没有 `submitOrder` 或 `cancelOrder` 能力。每个读取请求写 metadata-only 审计，不记录真实账号、secret header、token 或完整账户正文；不联网、不接真实 broker。

目标：

- 实现只读 broker 抽象，用于未来只读 smoke。

验收：

- 只能查询账户、资金、持仓、委托、成交。
- 没有 submitOrder 能力。
- 审计所有只读请求 metadata。
- 不写真实账号，不联网。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R10-2。
实现 ReadOnlyBroker 抽象和 fake 只读适配器。
只能查询，不能下单或撤单；不接真实 broker，不联网。
补测试并更新 broker README。
运行 npm run typecheck 和 npm test。
```

### R10-3 QMT fake subprocess bridge

状态：已完成，2026-06-16。已实现 `QmtFakeSubprocessBridge` fake 协议测试版，stdin 请求使用 `secretary.qmt.fake-bridge.v1`，stdout 支持 JSON 和 `SECRETARY_QMT_RESULT_JSON:` 前缀；只允许查询类命令，错误和 stderr 脱敏，超时会终止 fake 子进程。不调用 MiniQMT、不写账号、不联网、不下单。

目标：

- 只实现 QMT 子进程桥接协议的 fake 版本。

验收：

- 明确 stdin/stdout JSON 协议。
- 支持查询类命令和错误返回。
- stderr 脱敏。
- 超时终止 fake 进程。
- 不调用 MiniQMT，不写账号，不联网。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R10-3。
实现 QMT fake subprocess bridge 协议测试版。
不调用 MiniQMT，不写账号，不联网，不下单。
覆盖 stdout JSON、错误返回、超时终止和 stderr 脱敏。
运行 npm run typecheck 和 npm test。
```

### R10-4 PTrade ADR 更新

状态：已完成，2026-06-16。已更新实盘预备 ADR，明确 PTrade 更适合作为券商侧托管环境或独立量化平台评估，必须先确认权限、环境隔离、日志导出、对账和发布回滚要求；当前不实现 `PTradeBroker`，不写券商账号，不下单。

目标：

- 只更新 PTrade 接入评估，不实现 broker。

验收：

- 明确 PTrade 更适合券商侧托管或独立平台。
- 明确权限、日志导出、对账和隔离要求。
- 不写券商账号，不下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R10-4。
只更新 PTrade 接入 ADR，不实现 PTradeBroker。
重点说明权限、环境隔离、日志导出和对账要求。
运行 npm run check:docs。
```

## 14. R11 对账系统

### R11-1 ReconciliationResult 领域模型

目标：

- 定义本地状态和 broker/fake broker 状态的对账结果。

验收：

- 覆盖资金、持仓、可卖、冻结、委托、成交、intentId 映射。
- 支持 `matched`、`mismatch`、`unknown`、`needs_manual_review`。
- 不访问文件系统。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R11-1。
实现 ReconciliationResult 领域模型。
覆盖资金、持仓、可卖、冻结、委托、成交和 intentId 映射。
补单元测试并更新 trading/broker README。
运行 npm run typecheck 和 npm test。
```

### R11-2 Fake broker 对账服务

目标：

- 用 fake/read-only broker 数据验证对账流程。

验收：

- 能比较本地 portfolio/order/execution 和 fake broker snapshot。
- mismatch 写审计并生成 critical 通知事件。
- 不自动继续下单。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R11-2。
实现 fake broker 对账服务。
对账失败必须写审计并生成 critical 通知事件，不自动继续下单。
补集成测试并更新 broker/runtime README。
运行 npm run typecheck 和 npm test。
```

### R11-3 对账失败降级策略

目标：

- 明确 mismatch 后系统进入 readOnly/cancelOnly 的规则。

验收：

- mismatch 后打开账户级安全状态。
- 需要人工解除。
- 解除操作写审计。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R11-3。
实现对账失败后的降级策略。
mismatch 后进入账户级 readOnly 或 cancelOnly，解除必须人工并写审计。
补测试并更新 risk/broker README。
运行 npm run typecheck 和 npm test。
```

## 15. R12 人工审批持久化和入口

### R12-1 ApprovalRecord 存储

目标：

- 把人工审批记录从内存/测试对象推进到可审计存储。

验收：

- 记录 proposalId、approvalId、reviewer、decision、reviewedAt、operatorSessionId、riskSnapshotRef。
- 追加写入或原子写入。
- 不存敏感 token。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R12-1。
实现 ApprovalRecord 存储。
记录 proposalId、approvalId、reviewer、decision、operatorSessionId 和 riskSnapshotRef。
不存 token，不接 broker。
补测试并更新 memory/proposals README。
运行 npm run typecheck 和 npm test。
```

### R12-2 Manual confirm API

目标：

- 实现本地 API 或 webhook 入口，用于人工审批提案。

验收：

- 只能更新 proposal/approval 状态。
- 不能直接触发 broker。
- 需要鉴权、审计和幂等 requestId。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R12-2。
实现 Manual confirm API 或 webhook 入口。
入口只能更新人工审批记录，不能直接触发 broker。
补鉴权、审计、幂等测试并更新 interfaces README。
运行 npm run typecheck 和 npm test。
```

### R12-3 本地审批 CLI

目标：

- 提供仅供开发使用的本地审批命令。

验收：

- 能列出 pending_review 提案。
- 能 approve/reject，并写 ApprovalRecord。
- 默认不调用 ManualConfirmBroker handoff。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R12-3。
实现本地人工审批 CLI，支持列出 pending 提案和 approve/reject。
默认不触发 broker handoff，不接真实 broker。
补测试并更新 scripts/dev README。
运行 npm run typecheck 和 npm test。
```

## 16. R13 实盘 smoke 设计，仍不自动实盘

### R13-1 只读 smoke 脚本设计

目标：

- 只设计未来读取真实账户状态的 smoke，不实现真实 broker。

验收：

- 明确前置条件、环境变量、allowlist、审计字段和失败降级。
- 没有下单、撤单或改账户能力。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R13-1。
只写只读 broker smoke 设计，不实现真实 broker，不写账号，不下单。
重点说明 allowlist、审计、失败降级和人工操作步骤。
运行 npm run check:docs。
```

### R13-2 fake live rehearsal

目标：

- 用 fake live broker 演练人工审批、gate、风控、对账、通知闭环。

验收：

- 使用临时目录和 fake provider。
- 不联网，不调用真实 LLM，不接真实 broker。
- 覆盖 approved proposal 到 fake delegate，再到 reconciliation 和 audit。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R13-2。
实现 fake live rehearsal 集成测试。
使用临时目录，不联网，不调用真实 LLM，不接真实 broker。
覆盖人工审批、LiveTradingGate、PolicyEngine、RiskEngine、fake delegate、对账和审计。
运行 npm run typecheck 和 npm test。
```

### R13-3 小额人工实盘 smoke 评估

目标：

- 只在 R9-R12 稳定后评估，且需要用户明确批准。

硬条件：

- 已完成 LiveTradingGate。
- 已完成账户 allowlist。
- 已完成人工审批持久化。
- 已完成 read-only broker smoke。
- 已完成对账。
- 已完成应急停机。
- 已完成真实 broker ADR 和 contract test。
- 用户明确提供外部环境和授权。

禁止：

- 禁止自动买入。
- 禁止 LLM 输出直接成为订单。
- 禁止只靠 `LIVE_TRADING=true` 发单。
- 禁止保存明文交易密码。

交给 AI 的提示词：

```text
请评估 docs/requirement/post-u10-remaining-implementation-checklist.md 的 R13-3。
只评估小额人工实盘 smoke 条件，不实现真实 broker，不写账号，不下单。
检查 LiveTradingGate、allowlist、人工确认、风控、审计、对账和应急停机是否全部满足。
```

## 17. 暂不建议现在做的事项

暂缓：

- 真实 `QmtBroker`。
- 真实 `PTradeBroker`。
- 自动实盘买入。
- 大型向量数据库。
- 让模型直接执行工具或 broker。
- 用模拟点击客户端替代正式 API。
- 依赖 web search 自动生成 100 支自选股并直接落为交易候选。

原因：

- 当前系统的确定性安全底座已补只读/fake live broker contract 和 QMT fake 协议，但仍缺对账、持久化审批、真实 broker adapter 和真实只读 smoke；LiveTradingGate、allowlist 和 kill switch 已完成第一版非交易性门禁。
- 原始需求里有很多“看盘”和“提示”能力，可以先做成只读和提案链路。
- 真正触及资金前，必须先把非交易性实盘底座验证稳定。

## 18. 每轮完成后的汇报要求

每完成一个 R 任务，按以下格式收尾：

```text
请按 docs/ai/checklists/change-checklist.md 检查本次改动。
说明完成了什么、验证了什么、还剩什么风险。
```

涉及代码的任务默认运行：

```powershell
npm run typecheck
npm test
```

只改文档的任务默认运行：

```powershell
npm run check:docs
```
