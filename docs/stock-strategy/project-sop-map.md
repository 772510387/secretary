# 项目 SOP 总图：数据流向 / 闹钟 / 业务线

> 落盘时间：2026-06-27　会话标识：project-sop-map

## 1. 本会话探查范围

本会话把当前项目的实际源码链路整理成三套 SOP：数据流向 SOP、闹钟 SOP、业务线 SOP。目标不是复述需求，而是给后续判断“现在能力点能不能闭环、哪里会断、下一步怎么迭代”提供一张可追溯总图。

本次重点阅读了根目录协作规则、架构文档、`scripts/dev/cerebellum-daemon.ts`、`scripts/dev/build-context.ts`、`src/app/alarm-brain.ts`、选股池/漏斗/模拟成交/哨兵相关模块，以及 `docs/stock-strategy` 既有审计文件。没有实际启动 daemon，也没有验证外部行情/搜索 provider 的在线可用性。

## 2. 关键发现（必须带证据）

- 项目口径已调整为“确定性事实和账本可审计，模型承担强判断、强策略和执行提案”。AGENTS 与根 README 现在强调运行模式按配置区分，资金相关动作需要经过 PolicyEngine、RiskEngine、LiveTradingGate、OrderManager、BrokerAdapter、Reconciliation、AuditLog 等可追溯链路。
- 架构上，领域层不直接访问网络/文件/模型 SDK，外部世界放在 infrastructure；模块地图把行情、历史、新闻、LLM SDK 适配归到 `src/infrastructure/providers`，见 [AGENTS.md:28](../../AGENTS.md#L28)-[29](../../AGENTS.md#L29)、[module-map.md:23](../architecture/module-map.md#L23)。
- 固定闹钟是硬编码矩阵，不是模型自己决定。`FIXED_CEREBELLUM_ALARM_RULES` 定义在 [alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts)，覆盖 08:00、08:15、08:30、09:15、09:25、10:30、11:30、13:30、14:30、15:00、15:30、20:30、21:00、00:00，以及周/月/年复盘节点。
- 固定闹钟的触发是每分钟轮询、北京时区命中、slot 去重。`AlarmJobRegistry.runDue()` 在 [alarm-job-registry.ts:67](../../src/infrastructure/scheduler/alarm-job-registry.ts#L67)-[100](../../src/infrastructure/scheduler/alarm-job-registry.ts#L100) 比对 `beijingTime`、过滤工作日、生成 slot key 并避免重复执行。
- 当前代码已经把“100 高关注池换血”前移为多数交易日节点的前置动作，不只是 08:30/09:15。`REFRESH_POOL_NODES` 明确写了每个固定交易日闹钟都是全市场探查和 pool refresh，且池为空时任何节点都会刷新，见 [cerebellum-daemon.ts:88](../../scripts/dev/cerebellum-daemon.ts#L88)-[117](../../scripts/dev/cerebellum-daemon.ts#L117) 和实际调用 [cerebellum-daemon.ts:241](../../scripts/dev/cerebellum-daemon.ts#L241)-[260](../../scripts/dev/cerebellum-daemon.ts#L260)。
- 数据上下文由代码组装给大脑。`buildBridgeContext()` 读取账户、持仓、100 池、池概览，给持仓和池内股票取报价，持仓取技术指标，节点取搜索词，同时取指数、web search、dataHealth、龙虎榜、持仓主力净流入等，见 [build-context.ts:106](../../scripts/dev/build-context.ts#L106)-[183](../../scripts/dev/build-context.ts#L183)。
- 100 池刷新现在是确定性全市场管道：东财/新浪 universe、Sina 主力净流入、东财概念题材、腾讯盘口封单/一字板、60 日趋势、涨跌停/连板、板块热度、市场成交额，然后落 `watchlist_today.json` 和时间戳池快照。主流程见 [build-context.ts:599](../../scripts/dev/build-context.ts#L599)-[733](../../scripts/dev/build-context.ts#L733)。
- 空结果保护已经有实现：`persistCategorizedPool()` 支持 `skipWriteWhenEmpty`，避免空筛选覆盖好池，见 [build-watchlist.ts:209](../../src/app/build-watchlist.ts#L209)-[288](../../src/app/build-watchlist.ts#L288)；刷新失败会降级复用上次池，见 [build-context.ts:732](../../scripts/dev/build-context.ts#L732)-[750](../../scripts/dev/build-context.ts#L750)。
- 大脑节点分析是只读报告链路。`runAlarmNodeAnalysis()` 基于 SOP、行情相位、数据健康、池概览、日内 timeline、成交账单、持仓影响等拼 prompt，然后调用模型并推送通知，见 [alarm-brain.ts:117](../../src/app/alarm-brain.ts#L117)-[195](../../src/app/alarm-brain.ts#L195)。
- 选股漏斗和模拟成交是“脑给候选，代码落规则”。`selectFunnelStage()` 限制 BUY 必须来自真实 pool、SELL 必须来自持仓，产物是 review-required proposals，见 [select-funnel.ts:65](../../src/app/select-funnel.ts#L65)-[75](../../src/app/select-funnel.ts#L75) 和 [select-funnel.ts:119](../../src/app/select-funnel.ts#L119)-[181](../../src/app/select-funnel.ts#L181)。
- 漏斗执行遇到 100 池为空会硬跳过。`runFunnelNode()` 在 [cerebellum-daemon.ts:467](../../scripts/dev/cerebellum-daemon.ts#L467)-[470](../../scripts/dev/cerebellum-daemon.ts#L470) 明确跳过；只有连续竞价时段且 paper-only 校验通过才会成交，见 [cerebellum-daemon.ts:477](../../scripts/dev/cerebellum-daemon.ts#L477)-[492](../../scripts/dev/cerebellum-daemon.ts#L492)。
- 模拟成交的“手”是 `executePendingOrder()`，先 `assertPaperOnly`，再按确定性价格/数量构造 `TradeIntent`，跑 `RiskEngine`，最后由 `PaperBroker` 写账户、持仓、成交记录，见 [execute-pending-order.ts:60](../../src/app/execute-pending-order.ts#L60)-[152](../../src/app/execute-pending-order.ts#L152)。
- 回放链路已经有 no-lookahead 设计，但有边界：账户/持仓仍用当前存储状态，web search 和盘中分钟数据没有 as-of 源，deep_review 跳过；没有历史池快照时可用当前 universe 补池但会标 caveat，见 [cerebellum-daemon.ts:1006](../../scripts/dev/cerebellum-daemon.ts#L1006)-[1017](../../scripts/dev/cerebellum-daemon.ts#L1017)、[cerebellum-daemon.ts:1053](../../scripts/dev/cerebellum-daemon.ts#L1053)-[1085](../../scripts/dev/cerebellum-daemon.ts#L1085)。
- 行情哨兵是独立业务线：每 tick 读模拟持仓、取腾讯行情、跑确定性 MarketSentinel、标记持仓市值、记录异常、必要时推送；8% 硬止损只走 paper 强制平仓，见 [market-sentinel-daemon.ts:377](../../scripts/dev/market-sentinel-daemon.ts#L377)-[442](../../scripts/dev/market-sentinel-daemon.ts#L442)。

## 3. 现状判定（逐能力点）

### 3.1 数据流向 SOP

标准日内闹钟数据流：

```text
AlarmJobRegistry 命中固定节点
  -> T+1 结算
  -> 全市场探查 / 100 池刷新 / 池快照
  -> buildBridgeContext 组装账户、持仓、行情、指数、搜索、池概览、数据健康
  -> runAlarmNodeAnalysis 只读大脑报告并推送
  -> 漏斗节点维护 shortlist10 / proposals
  -> 连续交易时段 + paper-only 时执行模拟成交
  -> 盘后快照、成交账单、知识沉淀、旧数据清理
```

| 环节 | 当前输入 | 当前输出 | 落库/副作用 | 状态 |
|---|---|---|---|---|
| 闹钟触发 | 固定矩阵、当前北京时间 | alarmType、now | slot 去重 | 已实现，见 [alarm-job-registry.ts:67](../../src/infrastructure/scheduler/alarm-job-registry.ts#L67) |
| T+1 结算 | paper account/positions | 更新可卖数量 | `memory/portfolio` | 已实现，见 [cerebellum-daemon.ts:225](../../scripts/dev/cerebellum-daemon.ts#L225)-[234](../../scripts/dev/cerebellum-daemon.ts#L234) |
| 100 池刷新 | universe、持仓、昨日涨跌停、题材、盘口、趋势 | `watchlist100`、poolOverview、themeHeat | `watchlist_today.json`、limit-board、pool-snapshots | 已实现，但依赖外部 provider 可用性，见 [build-context.ts:599](../../scripts/dev/build-context.ts#L599)-[733](../../scripts/dev/build-context.ts#L733) |
| 上下文构建 | 账户、持仓、100 池、报价、技术指标、指数、web search | `RunAlarmNodeInput` | 无直接写交易 | 已实现，见 [build-context.ts:106](../../scripts/dev/build-context.ts#L106)-[183](../../scripts/dev/build-context.ts#L183) |
| 大脑分析 | SOP + context + dataHealth | 文本报告、通知事件 | 推送通知 | 已实现，见 [alarm-brain.ts:117](../../src/app/alarm-brain.ts#L117)-[195](../../src/app/alarm-brain.ts#L195) |
| 漏斗选股 | 100 池、持仓、执行约束、模型 shortlist | plan、shortlist10、proposals | `memory/plans`、`memory/proposals`、`potential_stocks.json` | 已实现，空池硬跳过，见 [cerebellum-daemon.ts:503](../../scripts/dev/cerebellum-daemon.ts#L503)-[540](../../scripts/dev/cerebellum-daemon.ts#L540) |
| 模拟成交 | proposal、报价、paper account | filled/rejected/skipped | 账户、持仓、trades 账本 | 已实现，paper-only，见 [execute-pending-order.ts:60](../../src/app/execute-pending-order.ts#L60)-[152](../../src/app/execute-pending-order.ts#L152) |
| 盘后归档 | account、positions、prices | 日终快照、摘要 | `memory/portfolio/snapshots` | 已实现，见 [archive-daily-snapshot.ts:62](../../src/app/archive-daily-snapshot.ts#L62) |
| 记忆沉淀 | 当日材料、模型 | lesson、规则提议 | 长期记忆、review-required rule proposals | 部分实现，见 [distill-daily-knowledge.ts:56](../../src/app/distill-daily-knowledge.ts#L56) |
| 历史回放 | date、as-of bars、池快照或补池 | 节点报告、漏斗结果 | 可推送、可落复盘 | 部分实现，历史账户/盘中/web search as-of 不完整，见 [cerebellum-daemon.ts:1006](../../scripts/dev/cerebellum-daemon.ts#L1006)-[1017](../../scripts/dev/cerebellum-daemon.ts#L1017) |

判断：日内模拟盘链路已经可形成“数据探查 -> 报告 -> 选股提案 -> 纸面成交 -> 归档沉淀”的闭环。最大断点不是大脑是否会说，而是外部行情/搜索 provider 不可用、100 池刷新失败、模型预算耗尽、以及回放 as-of 数据不足。

### 3.2 闹钟 SOP

| 时间 | alarmType | 节点 SOP | 数据动作 | 业务动作 | 当前判定 |
|---|---|---|---|---|---|
| 08:00 | `data_warmup` | 本地体检、确认账本和池状态 | 会触发 pool refresh；本地自检账户/持仓/池 | 不交易，仅准备 | 已实现，见 [alarm-matrix.ts:21](../../src/domain/cerebellum/alarm-matrix.ts#L21)-[26](../../src/domain/cerebellum/alarm-matrix.ts#L26)、[data-warmup-check.ts:26](../../src/app/data-warmup-check.ts#L26) |
| 08:15 | `overnight_digest` | 隔夜消息和持仓影响 | 节点搜索词覆盖美股、中概、A50、政策；读取持仓影响 | 报告为主 | 已实现，见 [search-query.ts:25](../../src/domain/cerebellum/search-query.ts#L25)-[26](../../src/domain/cerebellum/search-query.ts#L26)、[alarm-brain.ts:127](../../src/app/alarm-brain.ts#L127)-[133](../../src/app/alarm-brain.ts#L133) |
| 08:30 | `pre_market_plan` | 早盘计划 | 刷新 100 池，组装 poolOverview | 维护漏斗；非连续竞价只出提案 | 已实现，见 [cerebellum-daemon.ts:88](../../scripts/dev/cerebellum-daemon.ts#L88)-[117](../../scripts/dev/cerebellum-daemon.ts#L117)、[cerebellum-daemon.ts:487](../../scripts/dev/cerebellum-daemon.ts#L487)-[492](../../scripts/dev/cerebellum-daemon.ts#L492) |
| 09:15 | `call_auction_watch` | 竞价风向标 | 搜索词包含集合竞价/涨停/一字板/连板；刷新池 | 维护漏斗；竞价段不成交 | 部分实现，真竞价封单依赖腾讯盘口和当前取数时点，见 [search-query.ts:28](../../src/domain/cerebellum/search-query.ts#L28)、[build-context.ts:654](../../scripts/dev/build-context.ts#L654) |
| 09:25 | `pre_open_confirmation` | 开盘确认 | 刷新池，复核开盘前条件 | 仍不按昨收假成交 | 已实现，见 [alarm-matrix.ts:51](../../src/domain/cerebellum/alarm-matrix.ts#L51)-[58](../../src/domain/cerebellum/alarm-matrix.ts#L58) |
| 10:30 | `morning_review` | 早盘复核 | 刷新池、记录日内 checkpoint | 连续竞价时可 paper auto-fill | 已对齐 daily-alarm-list 的上午必报点 |
| 11:30 | `midday_review` | 午盘复核 | 刷新池、记录日内 checkpoint | 午休时只出提案 | 已实现，见 [alarm-matrix.ts:67](../../src/domain/cerebellum/alarm-matrix.ts#L67)-[74](../../src/domain/cerebellum/alarm-matrix.ts#L74) |
| 13:30 | `afternoon_risk_scan` | 午后风险扫描 | 刷新池、记录日内 checkpoint | 连续竞价时可 paper auto-fill | 已对齐 daily-alarm-list 的午后跳水必报点 |
| 14:30 | `late_session_plan` | 尾盘计划 | 刷新池、记录日内 checkpoint | 连续竞价时可 paper auto-fill | 已实现，见 [alarm-matrix.ts:83](../../src/domain/cerebellum/alarm-matrix.ts#L83)-[90](../../src/domain/cerebellum/alarm-matrix.ts#L90) |
| 15:00 | `closing_snapshot` | 收盘快照 | 刷新池 | 报告为主 | 已实现，见 [alarm-matrix.ts:91](../../src/domain/cerebellum/alarm-matrix.ts#L91)-[98](../../src/domain/cerebellum/alarm-matrix.ts#L98) |
| 15:30 | `post_close_review` | 盘后复盘 | 读取成交账单、龙虎榜、归档快照 | 日终快照落库 | 已实现，见 [cerebellum-daemon.ts:324](../../scripts/dev/cerebellum-daemon.ts#L324)-[331](../../scripts/dev/cerebellum-daemon.ts#L331)、[cerebellum-daemon.ts:398](../../scripts/dev/cerebellum-daemon.ts#L398)-[414](../../scripts/dev/cerebellum-daemon.ts#L414) |
| 20:30 | `deep_review` | 深度复盘 | 可路由 deep research | 报告为主 | 部分实现，依赖 researchRunner 配置，见 [cerebellum-daemon.ts:83](../../scripts/dev/cerebellum-daemon.ts#L83)、[cerebellum-daemon.ts:236](../../scripts/dev/cerebellum-daemon.ts#L236)-[239](../../scripts/dev/cerebellum-daemon.ts#L239) |
| 21:00 | `next_day_watchlist` | 次日观察与知识沉淀 | 读取成交账单，沉淀 lesson/rule proposals，清理旧数据 | 不交易 | 已实现一部分，见 [cerebellum-daemon.ts:417](../../scripts/dev/cerebellum-daemon.ts#L417)-[440](../../scripts/dev/cerebellum-daemon.ts#L440) |
| 00:00 | `daily_reflection` | 日终自省 | 读取当日成交账单 | 报告为主 | 已实现，见 [alarm-matrix.ts:123](../../src/domain/cerebellum/alarm-matrix.ts#L123)-[132](../../src/domain/cerebellum/alarm-matrix.ts#L132) |
| 周/月/年 | `weekly_review` / `monthly_review` / `yearly_review` | 周期复盘 | period review 落 markdown | 不交易 | 已实现基础落盘，见 [cerebellum-daemon.ts:370](../../scripts/dev/cerebellum-daemon.ts#L370)-[390](../../scripts/dev/cerebellum-daemon.ts#L390) |

判断：固定闹钟矩阵和运行编排已经可用。10:30、13:30 已对齐为必报点；10:00、14:00 现在属于链式静默巡航槽位。09:15/09:25 的竞价数据仍要明确是“搜索文本辅助”还是“盘口结构化事实”。

### 3.3 业务线 SOP

| 业务线 | 入口 | 标准 SOP | 当前能力 | 主要风险 |
|---|---|---|---|---|
| 固定闹钟日内运营 | `cerebellum-daemon` + alarm matrix | 命中节点 -> T+1 -> 刷池 -> 组 context -> 大脑报告 -> 漏斗/归档/沉淀 | 可跑模拟盘日内闭环 | provider、模型预算、池为空、非连续竞价不成交 |
| 100 池/潜力股维护 | `refreshWatchlist100()` + `runFunnelNode()` | 全市场 universe -> 分类池 -> 写 `watchlist_today.json` -> 漏斗写 `potential_stocks.json` | 已具备 100 池和 10 潜力股产物 | 外部源失败时降级；需监控空池告警 |
| 模拟交易执行 | funnel proposals 或 agent paper tools | proposal -> `executePendingOrder()` -> paper-only -> RiskEngine -> PaperBroker -> ledger | 可执行 paper buy/sell 和止损平仓 | 不能当实盘；真实交易门禁仍未进入自动发单 |
| 聊天/命令触发操作 | paper agent tools / `run_paper_ops` | 用户意图 -> 工具 -> 确定性执行手 | 可通过 paper 工具走同一 deterministic hand | 需要区分“建议”与“已执行 paper”文案 |
| 行情哨兵/风控巡航 | `market-sentinel-daemon` | tick -> 读持仓 -> 腾讯报价 -> 确定性异常 -> 推送或 paper 止损 | 已实现 3 秒哨兵和慢巡航基础 | 网络抖动、冷却状态、外部推送门禁 |
| 历史日回放 | `runReplayDay()` | 枚举当天节点 -> as-of 历史行情 -> 节点报告 -> 漏斗 | 可做“无未来函数”的近似回放 | 历史账户/持仓、盘中分钟、web search as-of 不完整 |
| 盘后复盘与沉淀 | 15:30、21:00、00:00 | 成交账单 -> 复盘报告 -> lesson/rule proposal -> 清理旧数据 | 有账单注入和知识沉淀 | 复盘事实层和胜率/回撤等指标仍需补齐 |
| 实盘准备 | LiveTradingGate/ManualConfirmBroker/未来 BrokerAdapter 架构 | TradeIntent -> Policy/Risk/Gate/Broker/Reconcile/Audit | 架构具备接入口径，按配置推进 | 自动化执行需要继续补 broker、对账和运行态观测 |

判断：当前业务能力已经适合“模型强判断 + 纸面/配置化执行 + 节点报告 + 日终归档 + 近似回放 + 风控哨兵”。下一阶段若推进真实下单，应把 `trade.js`/BrokerAdapter 接成配置化执行手，并补齐 broker 回执、对账、运行态观测和审计。

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 做一条“100 池健康”硬告警：刷新失败、降级复用、最终空池时在报告和 runtime-health 中明确标红，避免再次出现“流程跑了但全跳过” | `scripts/dev/cerebellum-daemon.ts`、`scripts/dev/build-context.ts`、health/log 模块 | 现有 `dataHealth` 和空池 skip |
| P0 | 对齐 08:15/08:30/09:15 的事实层输出契约：每个节点必须列出数据源、时间戳、是否结构化、是否搜索文本，尤其是竞价封单/一字板 | `src/app/alarm-brain.ts`、`src/domain/cerebellum/alarm-sop.ts`、`scripts/dev/build-context.ts` | 当前 prompt 和 `RunAlarmNodeInput` |
| P0 | 补“复盘 factpack”：成交、持仓、指数、池变化、日内 checkpoint、数据健康先由代码渲染，再交给模型写结论 | `src/app/review-*` 新模块、`alarm-brain.ts`、`daily-fills-ledger.ts` | review-grounding 专项结论 |
| P0 | 回放能力标注分级：严格 as-of、补池非 as-of、当前存量池三种模式在输出中强制显示，避免历史回放被误读 | `scripts/dev/cerebellum-daemon.ts`、回放命令入口 | 已有 poolCaveat |
| 已完成 | 对齐闹钟时间：10:30、13:30 为必报点；10:00、14:00 归入链式静默巡航 | `src/domain/cerebellum/alarm-matrix.ts`、`silent-patrol.ts`、测试 | 已实现 |
| P1 | 把 09:15/09:25 竞价事实从“搜索辅助”升级为结构化 `auctionBoard/sealBoard` 输入，包含封单金额、封单王、最强题材 | `tencent-quote-provider.ts`、`src/domain/market/seal-board.ts`、`build-context.ts`、`alarm-brain.ts` | 腾讯盘口字段、涨停价算法 |
| P1 | 建立分钟/60min 记录器或 provider 桥，支撑盘中回放和加仓线判断 | `src/infrastructure/providers`、`memory/market/minute`、回放 context | market-data-source-matrix 已选方案 |
| P1 | 策略知识库桥接到漏斗：每个提案写 `strategy_id`、案例引用、复盘结果，形成可学习闭环 | `select-funnel.ts`、`maintain-daily-funnel.ts`、memory strategy 模块 | strategy-knowledge-base 专项方案 |
| P2 | 实盘只做只读券商接入和人工确认，不开启模型直连发单；先补 Reconciliation/AuditLog 可视化 | broker adapter、LiveTradingGate、审计日志 | 项目边界和安全门禁 |
| P2 | 自调度复查链：异常或不确定结论自动生成下一次检查点，不污染固定闹钟矩阵 | cerebellum event 层、scheduler、notification | board-judgment-chain 专项方案 |

## 5. 开放问题 / 信息缺口

- 本次没有实际联网跑 `refreshWatchlist100()`，所以不能确认东财、腾讯、新浪、web search 在当前机器/代理下稳定可用。
- 本次没有跑 daemon 或 replay 命令，所以只能基于源码判断链路，不声明某个具体交易日的执行结果真实可复现。
- `docs/stock-strategy/_IMPLEMENTATION-LOG.md` 记录了若干后续实现状态，但该文件当前在工作区中是新增文档；本 SOP 以源码证据为准，没有把 implementation log 当作唯一事实源。
- 业务侧需要明确“直接调用 trade.js 执行”是指 paper-only 自动成交，还是未来真实交易。按当前项目边界，后者必须继续走人工/门禁/审计，不应让 LLM 直连实盘。
- 如果“罗盘数据库”指外部数据库而不是本项目 `memory/` JSON 落库，本次未定位到对应 adapter，需要另开会话查数据库接入层。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- [scripts/dev/cerebellum-daemon.ts](../../scripts/dev/cerebellum-daemon.ts) ：闹钟总编排、刷新池、漏斗、回放、归档、沉淀，是最高冲突文件。
- [scripts/dev/build-context.ts](../../scripts/dev/build-context.ts) ：上下文构建、行情/搜索/provider 聚合、100 池刷新。
- [src/domain/cerebellum/alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts) ：固定闹钟时间表。
- [src/domain/cerebellum/alarm-sop.ts](../../src/domain/cerebellum/alarm-sop.ts) ：每个闹钟节点的 SOP 提示词。
- [src/domain/cerebellum/search-query.ts](../../src/domain/cerebellum/search-query.ts) ：节点级 web search 查询词。
- [src/app/alarm-brain.ts](../../src/app/alarm-brain.ts) ：闹钟 context 到大脑报告的桥。
- [src/app/build-watchlist.ts](../../src/app/build-watchlist.ts) ：100 池分类、概览、空写保护。
- [src/app/maintain-daily-funnel.ts](../../src/app/maintain-daily-funnel.ts) 和 [src/app/select-funnel.ts](../../src/app/select-funnel.ts) ：漏斗计划、10 潜力股、交易提案。
- [src/app/execute-pending-order.ts](../../src/app/execute-pending-order.ts) ：paper-only 确定性执行手。
- [scripts/dev/market-sentinel-daemon.ts](../../scripts/dev/market-sentinel-daemon.ts) ：行情哨兵和硬止损巡航。
- [src/app/archive-daily-snapshot.ts](../../src/app/archive-daily-snapshot.ts)、[src/app/daily-fills-ledger.ts](../../src/app/daily-fills-ledger.ts)、[src/app/distill-daily-knowledge.ts](../../src/app/distill-daily-knowledge.ts) ：盘后归档、账单、知识沉淀。
