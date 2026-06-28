# Proposal: 飞书深度闹钟反馈与盘面展示交付闭环

## Metadata

- proposal_id: `2026-06-28-130713-feishu-deep-alarm-display-d86b90e4`
- source: `codex-isolated-planning-session`
- created_at: `2026-06-28 13:07:13`
- suggested_output_path: `D:\Project\main\secretary\docs\proposals\inbox\2026-06-28-130713-feishu-deep-alarm-display-d86b90e4.md`
- proposal_type: `feature`
- priority: `P1`
- implementation_size: `M`
- risk_level: `medium`
- default_mode: `configurable`
- requires_real_trading: `optional`

## One Line Goal

让 `docs/display/expectation-display.md` 所示的盘中深度反馈，在飞书交互和主动推送中完整呈现，而不是只完成后台能力打通或短摘要提醒。

## Final Decisions

- 盘中“眼睛”由确定性小脑承担：3 秒级哨兵、固定闹钟矩阵、100 池换血、指数/自选/量价红线都必须由代码触发，平时不消耗 LLM。
- LLM 只在固定闹钟、红线异动或用户主动询问时负责解释、归因、策略推演、复盘与自然语言报告，不直接改账户、不直接实盘下单、不覆盖规则。
- 飞书输出必须承载完整深度报告：`summary` 不能只是一句摘要，主动推送通道必须支持长文本分片、顺序标记、脱敏和失败可观测。
- 闹钟报告应按“观察 -> 判断 -> 策略 -> 下一次复查 -> Boss 摘要”的深度组织，同时保留操作汇报、模拟盘执行结果、风险约束和数据缺口说明。
- 所有交易相关动作仍按配置运行；若产生买卖，必须走已有 paper-only、PolicyEngine、RiskEngine、T+1、100 股、主板、仓位和审计路径。

## Explicit Non Goals

- 不建设新的前端页面；本方案聚焦飞书文本交互和主动推送。
- 不把行情、风控、仓位、止损、涨跌停、T+1 等确定性规则写进 prompt 代替代码。

## User Value

- 老板在飞书里看到的是可执行深度：大盘、板块、持仓、watchlist、操作建议、下一次复查节点和风险边界都在一条连续上下文里。
- 系统真正从“后台有能力”升级为“交互反馈有深度”：固定闹钟和哨兵主动推送能达到 `expectation-display.md` 的盘中跟踪颗粒度。
- 长报告不会被通知 schema 或飞书单条文本长度截断，关键尾部结论、复查闹钟和操作复盘不会丢失。

## Scope

### In Scope

- 固定闹钟节点和哨兵异动唤醒后的飞书报告交付契约。
- 通知正文长度、分片发送、顺序标记、脱敏、失败记录。
- 闹钟报告 prompt/contract：要求完整结论写入可推送正文，而不是藏在 `structured`。
- 模拟盘操作汇报：说明做了什么、为什么、当前账户状态、下一步风险和是否成交。
- 与 `expectation-display.md` 对齐的报告结构、测试与文档说明。

### Out Of Scope

- UI/前端展示。
- 新的外部消息平台，除已有飞书主动推送通道外不新增真实通知服务。
- 交易规则重构，除非为报告呈现需要读取已有结果。

## Module Mapping

### Existing Modules Likely Affected

- `src/domain/notification`：通知事件 schema、正文长度上限、推送分类、脱敏边界。
- `src/infrastructure/notification/feishu-notifier.ts`：飞书主动推送、长文本分片、发送失败处理。
- `src/app/alarm-brain.ts`：固定闹钟 SOP 到大脑报告的 prompt/contract，确保完整结论进入 `summary`。
- `scripts/dev/cerebellum-daemon.ts`：闹钟矩阵主动推送、漏斗执行结果、深度复盘通知。
- `scripts/dev/secretary-daemon.ts`：全天候值守组合根，确保飞书对话、哨兵、闹钟矩阵同时运行。
- `src/app/maintain-daily-funnel.ts`：选股漏斗和模拟盘待买卖/成交汇报。
- `src/app/run-brain-agent.ts`：模型执行模拟盘操作后的“操作 + 逻辑”通知。
- `src/domain/cerebellum`：小脑事件、固定闹钟、静默巡航、红线规则。
- `src/infrastructure/scheduler`：北京时间闹钟、交易时段、防重入、常驻调度。
- `tests/unit`、`tests/integration`：通知、飞书、闹钟、哨兵、漏斗、守护进程测试。

### New Modules Or Files Proposed

- `docs/proposals/inbox/2026-06-28-130713-feishu-deep-alarm-display-d86b90e4.md`：本方案沉淀文件。
- `src/app/*display-contract*.ts` 或等价局部 helper：可选，用于沉淀不同闹钟节点的展示格式契约。
- `src/domain/notification/*chunking*.ts` 或等价局部 helper：可选，用于抽出长文本分片纯函数，便于单测。

### README Files To Check Or Update

- `src/domain/notification/README.md`：说明通知正文可承载深度报告、外部推送仍脱敏和可控。
- `src/infrastructure/notification/README.md`：说明飞书分片发送和失败处理。
- `src/app/README.md`：说明闹钟节点输出不只是任务对象，而是可推送的深度研判。
- `docs/ops/feishu-bot.md`：说明 `npm start` / `FEISHU_NOTIFY=1` 下主动推送会分片发送长报告。
- `README.md`：若启动方式或用户预期变化，需要同步“全天候值守”和飞书反馈深度。

## Architecture Fit

说明方案如何符合 secretary 边界：

- deterministic_rules: 触发条件、交易时间、冷却、去重、推送分类、分片长度、脱敏、T+1、100 股、主板、仓位、止损和模拟成交都由代码确定。
- llm_authority: LLM 只做新闻解释、题材归因、策略推演、复盘、自然语言报告和模拟盘建议草案。
- infrastructure_boundary: 飞书 SDK、行情 provider、模型 SDK 只在 `src/infrastructure` 或脚本组合层使用；领域层不直接联网。
- domain_boundary: `domain` 只定义事件、schema、规则和纯函数，不读写文件、不调用 SDK、不发飞书。
- auditability: 通知、研究、模拟成交、提案、风险事件和后台执行结果都必须保留事件 id、时间、来源、metadata 和审计线索。
- simulation_default: 交易结果归属由运行配置与执行适配器决定，报告层保留完整审计线索。

## Core Domain Rules

必须由确定性代码实现的规则：

- 红线触发：1 分钟急涨/急跌、突破前高、持仓止损、指数系统性风险、自选股异常、量价异常。
- 推送门禁：哪些事件可以打断飞书，哪些只写本地日志，必须由代码判定。
- 通知正文上限、飞书单条长度、分片顺序、失败重试或失败记录，必须由代码处理。
- 所有通知内容必须脱敏，密钥、token、secret、账号敏感字段不得进入飞书正文。
- 模拟盘成交必须经过现金、仓位、T+1、100 股、主板、禁买、熔断、重复 intent 防护。
- LLM 输出的交易建议只能作为草案或模拟盘输入，不能直接进入实盘 broker。

## Data Flow

### Inputs

- 固定闹钟节点：北京时间、alarmType、SOP、账户、持仓、最新行情、技术指标、指数、100 池、观察池概览、历史教训、当日成交账单。
- 哨兵节点：实时 quote、previous quote、持仓成本、自选股观察价、冷却状态、指数快照。
- 飞书用户消息：私聊文本、用户 open_id、对话历史、权限状态。
- LLM 输入：经过脱敏和裁剪的上下文包、SOP、展示契约和安全约束。

### Outputs

- 飞书主动推送：闹钟深度报告、红线异动研判、模拟盘操作汇报、深度复盘。
- 本地 console/file 通知日志。
- 模拟盘提案、模拟成交结果或拒单原因。
- 盘后/周/月/年复盘报告与知识沉淀草案。

### State To Persist

- 冷却状态和去重状态。
- 通知发送记录或 file notifier JSONL。
- 模拟盘账户、持仓、成交流水、日快照。
- 选股池、潜力股、池快照。
- 报告、研究结果、复盘、知识沉淀和待审核提案。

### Audit Records

- 小脑触发事件审计。
- 通知生成与外推结果审计。
- 模拟盘成交、拒单、幂等复用审计。
- LLM 输出校验失败或降级审计。
- 数据源缺失、网络失败、provider 超时审计。

## Configuration

### Required Config

- `FEISHU_NOTIFY`：是否启用飞书主动推送；默认 `false`；可选。
- `FEISHU_APP_ID`：飞书应用 id；启用飞书时必需；来自环境变量。
- `FEISHU_APP_SECRET`：飞书应用 secret；启用飞书时必需；来自环境变量。
- `FEISHU_ALLOWED_USERS`：允许交互和危险操作确认的用户；默认空则只读问答但危险操作禁用。
- `FEISHU_PUSH_USERS`：主动推送接收人；默认可回退到 `FEISHU_ALLOWED_USERS`；可选。
- `BRAIN_PROVIDER`：大脑 provider；默认可为 `mock`，真实深度需配置 `dashscope`、`openai` 等。
- `BRAIN_DAILY_LIMIT` 或现有预算配置：限制每日模型调用；默认按现有配置。
- `MARKET_SENTINEL_INTERVAL_MS` 或现有行情哨兵间隔配置：默认 3000ms 或项目现有值。

### Secrets

- 是否需要密钥：需要，仅在启用真实飞书或真实模型时需要。
- 密钥来源：环境变量或本机密钥管理。
- 禁止写入仓库的内容：飞书 app secret、模型 API key、webhook token、真实账户号、真实 broker 参数、任何 `.env` 明文。

## Error Handling

- 飞书单段发送失败时，记录失败 recipient 和 chunk index；不能让守护进程崩溃。
- 长报告分片必须保持顺序标记；部分发送失败要在 delivery result 暴露 partial。
- 数据源缺失时，报告必须明确“数据缺失/降级”，禁止模型编造指数、价格、连板、新闻。
- LLM 超时或结构化输出失败时，降级为确定性摘要或本地日志，不执行交易。
- 外部推送未配置时，系统仍应 console/file 落地，不阻断闹钟和哨兵。
- 模拟成交失败时，推送拒单原因并保留审计，不重试同一无效订单刷屏。

## Tests Required

### Unit Tests

- `notificationEventSchema` 接受深度报告正文并仍限制最大长度。
- 飞书分片函数：长文本多段、短文本单段、尾部结论不丢、每段长度不超过平台保守上限。
- 飞书通知脱敏：长文本中 token、apiKey、secret、password 被遮蔽。
- `shouldPushToExternalChannels` 对红线、执行操作、固定闹钟、普通噪音分类正确。
- `runAlarmNodeAnalysis` 的 prompt 包含展示契约、操作汇报格式、安全边界，并把完整报告放入可推送字段。
- 模拟盘操作通知保留足够的操作逻辑说明。

### Integration Tests

- `FeishuNotifier` 使用 mock sender 验证多 recipient、多 chunk、partial failure。
- `cerebellum-daemon` 手动触发固定节点时能生成可外推通知，不真实联网或使用 mock provider。
- `market-sentinel-daemon` 红线事件唤醒大脑后通知链路可落 console/file/feishu mock。
- `maintainDailyFunnel` 生成选股漏斗通知并包含候选理由、模拟成交结果或拒单原因。

### Manual Verification

- `npm run cerebellum:dev -- --fire pre_market_plan`：飞书收到完整盘前报告或分片报告。
- `npm run cerebellum:dev -- --fire morning_review`：飞书收到观察、判断、策略、复查节点。
- `npm run sentinel:dev -- --live --wake-brain`：红线触发时飞书收到异动事实和 AI 研判。
- 飞书长报告末尾包含“下一次复查/尾部决策/Boss 摘要”，未被截断。

## Acceptance Criteria

- 固定闹钟报告在飞书中可达到 `docs/display/expectation-display.md` 的结构深度，不再只显示短摘要。
- 长报告通过多条飞书消息按 `(1/N)` 顺序发送，尾部结论可见。
- 飞书推送正文不包含密钥、token、真实账号敏感信息。
- 平稳哨兵/静默巡航不消耗 LLM；只有红线、固定闹钟或用户请求唤醒大脑。
- 所有买卖仍按配置运行，且经过既有确定性规则、审计和 paper-only 门禁。
- `npm run typecheck` 和 `npm test` 通过。

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

1. 明确通知正文契约：提升可推送正文上限，统一裁剪 helper，并补 schema 单测。
2. 实现飞书主动推送分片：顺序标记、长度控制、脱敏、partial failure 记录，并补 notifier 单测。
3. 调整闹钟报告 contract：确保完整结论写入 `summary`，覆盖盘前、盘中、尾盘、收盘和深度复盘节点。
4. 调整模拟盘操作汇报：保留“操作 + 逻辑 + 当前账户 + 下一步风险”的正文，而非 1-2 句摘要。
5. 跑 `npm run typecheck`、相关单测和全量 `npm test`，再手动触发飞书节点验证展示深度。

## Notes For Coding Agent

后续实现以“确定性事实和触发 + 模型强判断和深度报告 + 执行适配器承接”为主线。飞书展示深度提升时仍要保留 notification schema、push policy、脱敏和审计链路，避免长报告、操作提案和执行结果不可追溯。

