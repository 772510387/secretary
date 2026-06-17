# U1-U10 能力实现归档清单

生成日期：2026-06-14
状态更新：2026-06-15

本清单接在 `post-t014-interaction-checklist.md` 之后使用。当前项目已经完成 T001-T014，并补过研究审计、手动研究入口、mock 研究闭环、人工确认提案模型、ManualConfirmBroker 设计、真实 BrainProvider/TradingAgents-CN runner 接入评估。

本文件现在是 U1-U10 的完成归档，不再作为下一步待实现清单使用。后续剩余能力统一从 `post-u10-remaining-implementation-checklist.md` 继续推进，避免后续 AI 重复实现已经完成或已经评估的模块。

## 0. 当前基线

最近完整验证：

- U1-U9 相关实现任务完成时均运行过 `npm run typecheck` 和 `npm test`。
- U10 为设计评估任务，运行过文档检查。
- R0 当前仅修正文档状态，验证命令为 `npm run check:docs`。
- 默认仍为 `LIVE_TRADING=false`、`BRAIN_PROVIDER=mock`、`BROKER_PROVIDER=paper`。
- 真实 Tencent quote smoke 已手动验证过一次，但默认测试仍跳过真实网络。

当前定位：

- 已具备可测试的模拟盘、研究报告、审计、mock 闭环、历史行情基础能力、记忆写入策略和轻量记忆检索索引。
- 已具备工具请求校验、计划生成边界、固定闹钟上下文包、本地通知通道、DashScope Qwen 真实模型 provider、TradingAgents-CN 子进程 runner fake subprocess 版、ManualConfirmBroker paper-only 门禁和 U10 实盘预备评估；尚未接真实外部 TradingAgents-CN 安装或真实 broker。

U1-U10 后仍剩余的主要风险：

- 还没有真实常驻 daemon、运行态 health 和 heartbeat。
- 原始需求中的完整全天闹钟矩阵、10 分钟静默巡航、自选股雷达、指数雷达和放量雷达还未全部工程化。
- Webhook/API 入口、真实微信或外部 webhook 通知还未实现。
- Post-U10 R8 已补 `OpenAIProvider`，并完成 GeminiProvider、Tushare/Akshare provider 评估；Gemini、Tushare 和 AkShare 仍未实现真实 provider。
- 语义向量检索还只是后续 ADR 任务。
- Post-U10 R9 已补 LiveTradingGate、账户 allowlist 和应急停机状态持久化；实盘仍缺只读 broker、fake live broker contract、对账系统和人工审批持久化。
- 真实 broker 和自动实盘买入仍明确禁止。

## 1. 安全边界

U1-U10 执行时遵守过这些边界；后续任务也应继续遵守，但新的执行入口在 `post-u10-remaining-implementation-checklist.md`：

- 一次只做一个任务。
- 默认不联网，真实网络 smoke 必须显式环境变量启用。
- 不写 API key、券商账号或真实交易参数。
- 不接真实 broker。
- 不实现自动实盘买入。
- LLM 不拥有工具执行权限。
- LLM 不直接改账户、规则、订单或 broker。
- 任何资金、交易、提案、记忆写入都必须保留审计线索。
- 涉及文件写入必须继续使用原子写入和备份策略。

## 2. U1-U10 历史完成顺序

以下顺序是已经执行过的历史路线，不是下一步待办：

1. U1 历史行情和技术指标。
2. U2 记忆写入策略。
3. U3 记忆检索和索引。
4. U4 ToolRuntime 工具请求校验。
5. U5 小脑固定闹钟矩阵和上下文包。
6. U6 通知通道。
7. U7 真实 BrainProvider。
8. U8 TradingAgents-CN 子进程 runner。
9. U9 ManualConfirmBroker 实现并只接 paper delegate。
10. U10 实盘预备任务，继续保持不自动实盘。

当时这样排序的原因：

- 先补“眼、记忆、工具边界、小脑上下文”这些确定性底座。
- 再接真实模型和外部研究流程。
- 最后才考虑人工确认到 broker 的链路。

当前新的后续实现入口是：

- `post-u10-remaining-implementation-checklist.md`

## 3. U1 历史行情和技术指标

状态：已完成，2026-06-14。

目标：

- 实现 `HistoryProvider` 抽象和 `TencentHistoryProvider`。
- 支持 A 股日 K 线历史数据。
- 计算 MA5、MA10、MA20、60 日最高/最低、区间位置、基础趋势标签。
- 默认测试只用 mock fetch，不把真实网络设为必跑。

建议范围：

- `src/domain/market`
- `src/infrastructure/providers`
- `tests/unit`
- `tests/integration`
- `src/infrastructure/providers/README.md`

验收：

- 能把腾讯历史行情转换成统一 `KlineBar` 或等价领域对象。
- 能处理空数据、停牌、字段缺失、HTTP 失败和超时。
- 技术指标计算有单元测试。
- 真实网络 smoke 需要显式环境变量，例如 `TENCENT_HISTORY_NETWORK=1`。
- 不调用 LLM，不写账户，不下单。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U1。
实现 HistoryProvider 抽象和 TencentHistoryProvider，默认只用 mock fetch 测试，不联网。
补 MA5/MA10/MA20、60 日区间位置和趋势标签测试，更新 providers README。
运行 npm run typecheck 和 npm test。
```

## 4. U2 记忆写入策略

状态：已完成，2026-06-14。

目标：

- 实现 `MemoryWritePolicy`。
- 明确哪些写入可以自动落地，哪些必须进入人工提案。
- 防止大脑直接削弱硬规则。

建议范围：

- `src/domain/memory`
- `src/infrastructure/storage`
- `memory/rules/README.md`
- `memory/proposals/README.md`
- `tests/unit`
- `tests/integration`

写入分类：

- 自动允许：普通复盘、经验总结、题材理解、错误模式、非敏感日志摘要。
- 受限允许：软阈值小幅调整，必须有范围上限、证据引用和审计。
- 必须提案：主板限制、T+1、100 股、8% 止损、单股 40%、实盘开关、broker 边界。
- 永远拒绝：删除审计、写入密钥、跳过风控、把 LLM 输出变成直接订单。

验收：

- 不同写入类型能得到 `allow`、`proposal_required` 或 `reject`。
- 规则削弱默认进入提案或拒绝。
- 所有策略判断有单元测试。
- 写入落盘路径仍由 storage 层负责，domain 层不直接访问文件系统。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U2。
实现 MemoryWritePolicy，区分自动写入、必须提案和拒绝写入。
不得让大脑直接削弱硬规则，不接 broker。
补单元测试并更新 memory README。
运行 npm run typecheck 和 npm test。
```

## 5. U3 记忆检索和索引

状态：已完成，2026-06-14。

目标：

- 实现轻量 `MemoryRegistry`、关键词搜索、最近记忆读取。
- 让大脑需要上下文时能通过确定性索引拿到对应材料。
- 第一阶段继续使用文件系统和 Markdown/JSON，不引入大型向量库。

建议范围：

- `src/domain/memory`
- `src/infrastructure/storage`
- `memory/README.md`
- `tests/integration`

验收：

- 能按 category 查询 `rules`、`research`、`reports`、`proposals`、`logs`。
- 能关键词搜索并返回文件路径、命中摘要、更新时间。
- 能读取最近 N 条研究报告或复盘报告的元数据。
- 搜索不返回密钥或运行态敏感正文。
- 测试使用临时目录。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U3。
实现轻量 MemoryRegistry 和关键词/最近记忆检索。
不引入向量数据库，不联网，不调用 LLM。
补集成测试并更新 memory README。
运行 npm run typecheck 和 npm test。
```

## 6. U4 ToolRuntime 工具请求校验

状态：已完成，2026-06-14。

目标：

- 实现后端工具请求校验层。
- 大脑只能提出结构化工具请求，不能直接执行工具。
- 交易类请求默认只能生成提案，不能触发 broker。

建议范围：

- `src/domain/brain`
- `src/domain/memory`
- `src/app`
- `tests/unit`
- `tests/integration`

工具类型建议：

- `read_memory`
- `search_memory`
- `get_quote`
- `fetch_history`
- `propose_memory_write`
- `propose_trade_intent`

禁止类型：

- `execute_order`
- `write_account`
- `overwrite_rule`
- `enable_live_trading`
- `read_secret`

验收：

- 合法只读工具请求能转成待执行计划。
- 写记忆请求必须经过 `MemoryWritePolicy`。
- 交易请求只能进入人工确认提案。
- 禁止工具请求被拒绝并写审计元数据。
- 不让模型拥有 `canExecute=true`。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U4。
实现 ToolRuntime 的请求校验和计划生成，不真正执行交易工具。
写记忆请求必须经过 MemoryWritePolicy，交易请求只能生成提案。
补测试并更新 brain/app README。
运行 npm run typecheck 和 npm test。
```

## 7. U5 小脑固定闹钟矩阵和上下文包

状态：已完成，2026-06-14。

目标：

- 在现有 Scheduler 基础上定义固定北京时间闹钟矩阵。
- 为每个闹钟生成确定性上下文包。
- 不启动真实常驻进程，只测试触发和上下文构造。

建议范围：

- `src/domain/cerebellum`
- `src/runtime`
- `src/app`
- `tests/unit`
- `tests/integration`
- `src/runtime/README.md`

闹钟优先级：

- 08:30 盘前计划。
- 11:30 午间回顾。
- 15:00 收盘回顾。
- 20:30 深度复盘。
- 00:00 每日自省。
- 周六 10:00 周复盘。
- 月末 20:00 月复盘。
- 12-31 20:00 年复盘。

验收：

- 所有闹钟使用北京时间。
- 周、月末、年末判断有测试。
- 上下文包只包含路径、摘要和必要元数据，不塞密钥。
- 触发后默认调用 mock BrainProvider 或只生成任务对象。
- 不启动真实 daemon，不联网，不接 broker。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U5。
实现小脑固定北京时间闹钟矩阵和上下文包构造。
不要启动真实常驻进程，不联网，不接 broker。
补周/月/年闹钟测试并更新 runtime/cerebellum README。
运行 npm run typecheck 和 npm test。
```

## 8. U6 通知通道

状态：已完成，2026-06-14。

目标：

- 实现通知领域模型和最小 console/file notifier。
- Webhook/微信只预留接口，不接真实外部系统。

建议范围：

- `src/domain/notification`
- `src/infrastructure`
- `tests/unit`
- `tests/integration`

验收：

- 通知事件包含时间、级别、来源、标的、摘要、建议动作、关联审计 ID。
- console notifier 可格式化输出。
- file notifier 使用原子写入或 append-only JSONL。
- 通知去重和冷却有测试。
- 不接真实微信、短信或 webhook。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U6。
实现 NotificationEvent、console notifier 和 file notifier。
不接真实微信或 webhook。
补测试并更新 notification README。
运行 npm run typecheck 和 npm test。
```

## 9. U7 真实 BrainProvider

状态：已完成，2026-06-14。

目标：

- 按 ADR 先实现 `DashScopeQwenProvider`，再考虑 `OpenAIProvider`，最后评估 `GeminiProvider`。
- 不写 API key。
- 默认测试使用 mock fetch。

前置条件：

- U2 `MemoryWritePolicy` 完成。
- U4 `ToolRuntime` 完成或至少禁止可执行工具链。

建议范围：

- `src/infrastructure/providers`
- `src/domain/brain`
- `tests/unit`
- `tests/integration`
- `src/infrastructure/providers/README.md`

验收：

- 缺 key 报清楚错误。
- 429、401/403、5xx、超时、空响应、坏 JSON、坏 schema 都有测试。
- 输出必须经过 `validateBrainOutput()`。
- 默认非流式 JSON Mode。
- 真实 smoke 需要显式环境变量，例如 `DASHSCOPE_BRAIN_NETWORK=1`。
- 不允许模型工具执行。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U7。
先实现 DashScopeQwenProvider，默认 mock fetch，不写 API key，不联网。
必须覆盖缺 key、429、超时、坏 JSON、坏 schema 和本地 Zod 校验。
不得让模型拥有工具执行权限。
运行 npm run typecheck 和 npm test。
```

## 10. U8 TradingAgents-CN 子进程 runner

状态：已完成，2026-06-15。

目标：

- 按 ADR 实现 `TradingAgentsCnSubprocessRunner`。
- 默认用 fake subprocess 测试。
- 不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。

前置条件：

- U1 历史行情完成更好，但不是硬前置。
- U4 工具边界完成更安全。

建议范围：

- `src/infrastructure/providers`
- `tests/integration`
- `src/infrastructure/providers/README.md`

验收：

- valid stdout JSON 能转换成 `ResearchReport`。
- `SECRETARY_RESULT_JSON:` 前缀输出能解析。
- 非零退出、坏 JSON、空输出、超时都能降级或抛出 `ResearchProviderError`。
- 超时会终止 fake 进程。
- stderr 脱敏。
- 不调用真实 LLM，不联网，不接 broker。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U8。
实现 TradingAgentsCnSubprocessRunner 的 fake subprocess 集成测试版。
不复制 TradingAgents-CN app/frontend，不调用真实 LLM，不联网，不接 broker。
覆盖 stdout JSON、前缀输出、非零退出、坏 JSON、超时终止和 stderr 脱敏。
运行 npm run typecheck 和 npm test。
```

## 11. U9 ManualConfirmBroker 实现，只接 paper delegate

状态：已完成，2026-06-15。

目标：

- 实现 `ManualConfirmBroker` 的人工确认门禁。
- 第一阶段只允许 delegate 到 `PaperBroker`。
- 仍不接真实 broker。

前置条件：

- U2 `MemoryWritePolicy` 完成。
- U4 `ToolRuntime` 完成。
- U6 通知通道完成更好，但不是硬前置。

建议范围：

- `src/infrastructure/broker`
- `src/domain/memory`
- `src/domain/trading`
- `tests/integration`
- `src/infrastructure/broker/README.md`

验收：

- 只有 `approved` 提案才能进入 handoff。
- handoff 前重新跑 PolicyEngine 和 RiskEngine。
- 审计记录 proposalId、approvalId、riskResult、policyResult、delegate broker。
- 未确认、已拒绝、过期、被撤销提案不能进入 broker。
- 第一阶段只接 `PaperBroker`，不接 live broker。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请执行 docs/requirement/unimplemented-capability-checklist.md 的 U9。
实现 ManualConfirmBroker，但第一阶段只允许 delegate 到 PaperBroker。
必须重新经过 PolicyEngine、RiskEngine 和 AuditLog。
未确认或已拒绝提案不能进入 broker，不接真实 broker。
运行 npm run typecheck 和 npm test。
```

## 12. U10 实盘预备任务，继续暂缓自动实盘

状态：已完成评估，2026-06-15。仍未实现真实 broker，仍不允许自动实盘。

这些任务只在 U1-U9 稳定后评估：

- U10-1 真实 broker 抽象补强。
- U10-2 QMT/PTrade 调研和 ADR。
- U10-3 实盘熔断和应急停机。
- U10-4 对账系统。
- U10-5 实盘最小人工确认 smoke 设计。

硬条件：

- `LIVE_TRADING=true` 仍然不足以发实盘单。
- 必须有账户 allowlist。
- 必须有人工确认。
- 必须有 PolicyEngine、RiskEngine、AuditLog。
- 必须有应急停机。
- 必须有对账。
- 必须先小额人工 smoke，不允许自动买入。

历史执行提示词，已完成，除非明确返工不要重复执行：

```text
请评估 docs/requirement/unimplemented-capability-checklist.md 的 U10。
只做实盘预备设计，不实现真实 broker，不写券商账号，不下单。
重点检查 LIVE_TRADING、人工确认、风控、审计、应急停机和对账边界。
```

## 13. 历史验证方式

U1-U9 涉及代码实现，完成时运行适用验证：

```powershell
npm run doctor
npm run typecheck
npm test
```

U10 和 R0 属于设计或文档状态同步，只改文档时可以只运行：

```powershell
npm run check:docs
```

每轮完成后按以下检查口径汇报：

```text
请按 docs/ai/checklists/change-checklist.md 检查本次改动。
说明完成了什么、验证了什么、还剩什么风险。
```

## 14. 当前下一步建议

建议下一步不要继续从本归档清单执行 U 任务。后续应从 `post-u10-remaining-implementation-checklist.md` 选择 R 任务，并继续暂停真实 broker 实现，先做非交易性实盘底座拆分。

理由：

- U1-U10 已经补齐行情、记忆写入、记忆检索、工具请求边界、固定闹钟上下文包、本地通知通道、DashScope Qwen provider、TradingAgents-CN 子进程 runner fake subprocess 版、paper-only 人工确认门禁和实盘预备评估。
- 后续即使继续推进，也应继续坚持不触发交易的底座：R9 已完成 `LiveTradingGate` schema、账户 allowlist schema 和 kill switch；下一步优先 fake `LiveBrokerAdapter` contract test、`ReconciliationResult` 领域模型和只读 smoke 方案。
- 真实 broker 仍必须等待 LIVE_TRADING、多重人工确认、账户 allowlist、PolicyEngine、RiskEngine、AuditLog、应急停机和对账流程全部明确后再进入实现。
