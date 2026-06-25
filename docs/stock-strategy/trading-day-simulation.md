# 交易日模拟（节点逐格复盘）：openclaw 是"叙述"，secretary 该做"接地"——现状与落地方案

> 落盘时间：2026-06-25　会话标识：trading-day-simulation

## 1. 本会话探查范围

老板贴出一份「📊 2026-06-09 完整交易日复盘」样本（初始 ¥100,000 → ¥101,055，9:25 建仓 / 9:45·10:00·14:50 减仓 / 逐闹钟节点决策表 + ASCII 价格走势 + 亮点/改进），并指明该产物落在 `/home/node/.openclaw/workspace/memory/logs/full_trading_simulation.md`。要求：① 判定这套「交易日模拟」在 secretary 是否实现；② 定实现方案；③ 给扩展。**硬约束（老板原话）：不要纯代码思路，要用 agent / harness / Claude Code 的实现方式去构想**。参考实现：`d:/Project/main/openclaw` 的 harness。

## 2. 关键发现（必须带证据）

- **关键定性：样本不是引擎算出来的，是 openclaw 让模型"演"出来的。** 路径 `~/.openclaw/workspace/memory/logs/` 是 openclaw 的**运行时家目录**（类比 `~/.claude/`），不在仓库里。openclaw 本体是一个**通用 agent harness**（README 自述 "a personal AI assistant you run on your own devices"，d:/Project/main/openclaw/README.md），其自动化原语是 **standing orders（常驻授权）+ cron（定时触发）+ skills + workspace 记忆 + Execute-Verify-Report**（[standing-orders.md](file:///d:/Project/main/openclaw/docs/automation/standing-orders.md)、`docs/automation/cron-jobs.md`、`.agents/skills/*/SKILL.md`、`docs/agent-runtime-architecture.md`）。它**没有任何 A 股分时数据源**。→ 样本里 12.50→12.55→12.68→…→13.25→12.32 这条分钟级价格曲线、每节点决策与盈亏，都是**模型即兴编的叙述**，不是回放真实行情。
- **这正是 secretary 自己审计点名要消灭的反模式。** 同目录 [review-grounding.md](review-grounding.md) 已判定 secretary 现有复盘"是模型口算口编、缺确定性事实层"（夏普/年化/胜率全 `src/` 零命中却出现在报告里；`tradedAt` 存 UTC 未做北京归一；无已实现 vs 浮动盈亏拆分；理由不回 join）。**照搬 openclaw 那种叙述式模拟 = 把幻觉写进盘。所以"是否实现"必须拆成两件本质不同的事。**
- **(A) 叙述版交易日复盘** —— 把"模拟一个交易日"丢给大脑让它编一份漂亮 markdown：secretary **随手就能做**（大脑+记忆写工具齐全），但**违反项目硬约束**（眼/小脑层不许模型编数），不该做。
- **(B) 接地版节点逐格回放**（价格/决策/成交/盈亏全确定性算，模型只写散文）：**substrate 已搭了约 80%**，但缺两块关键件 + 一块加分件。逐条见 §3。
- **节点回放骨架已存在且与实盘同一条脑路径。** 子 agent 报告（未逐行亲核，见 §5）：`src/runtime/replay-runner.ts` 的 `runReplay` 用 `SimulatedClock` 把时钟逐个钉到固定闹铃北京时间、逐节点建 as-of 快照；daemon 另有 `--replay-day`（`scripts/dev/cerebellum-daemon.ts` 的 `runReplayDay`）对历史某日逐节点跑真实 SOP+大脑并可执行漏斗纸面成交。回放与实盘**调用同一个** `runAlarmNodeAnalysis`（`src/app/alarm-brain.ts`）。
- **硬阻塞 = 没有分时行情。** 子 agent 亲核：`HistoryProvider` 只有 `getDailyKlines`，腾讯/fixture 两个 provider 都只取「日线」，全系统**无分钟/tick 源**（`src/infrastructure/providers/tencent-history-provider.ts`、`fixture-history-provider.ts`）。→ 同一历史日的所有盘中节点看到的是**同一根日线价**，物理上拼不出"9:25 @12.55 / 9:45 @13.12 / 10:00 @13.25"这种盘中价格纹理。
- **统一的「逐节点复盘报告」产物不存在。** 现有只有 console scorecard + JSON（hitRate/forward-return/equity），没有任何一个函数把"决策表 + 操作统计 + 日盈亏 + 走势图 + 亮点/改进"拼成一份人读的 md。`src/app/report-generation.ts` 的 `closing_review` 是脑生成建议，非接地 P&L 复盘（与 [review-grounding.md](review-grounding.md) 结论一致）。
- **回放的决策者目前是确定性桩，不是大脑。** 子 agent 报告：`src/app/replay-decider.ts` 是纯函数确定性 decider；`ReplayDecider` 接口预留了 `decider?:` 可换模型，但默认跑的是确定性版；打分也打在确定性 stance 上。而「脑 agent 在单回合内决策+执行纸面单」的能力在实盘链已通（`runBrainAgentTurn` + `paper_buy/paper_sell`），只是没接进回放当 decider。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 把历史某日按闹铃节点 9:15→15:00 逐格走一遍 | ✅已实现 | replay-runner.ts `runReplay` / cerebellum-daemon.ts `runReplayDay`（子agent报告） | 用 `SimulatedClock` 钉时钟 |
| 模拟时钟 seam（可注入覆盖 wall-clock） | ✅已实现 | `src/infrastructure/scheduler/simulated-clock.ts`、可注入 `AlarmJobRegistry`（子agent报告） | 回放/加速回放的钥匙 |
| 每节点 as-of 无前视快照 | ✅已实现 | `src/app/replay-snapshot.ts`（子agent报告） | 三层防前视 |
| 回放与实盘共用同一脑/SOP 路径 | ✅已实现 | `src/app/alarm-brain.ts` `runAlarmNodeAnalysis`（子agent报告） | 实盘 line~359、回放 line~1096 同调用 |
| 每节点纸面成交（按节点价撮合） | ✅已实现 | `paper-broker.ts` `submitOrder`、`execute-pending-order.ts`、漏斗节点回放内执行（子agent报告） | 价格调用方注入，非自取 |
| T+1 跨日 rollover / 当日成交账单 / 收盘快照 | ✅已实现 | `settleDailyPositions`、`daily-fills-ledger.ts`、`archive-daily-snapshot.ts`（子agent报告；T+1 另见 [board-judgment-chain.md](board-judgment-chain.md) §5 待验） | 复盘事实包的数据底座 |
| 回放决策者 = 大脑 agent 回合 | 🟡部分 | `replay-decider.ts` 确定性桩；`runBrainAgentTurn` 实盘已通但未接回放（子agent报告） | 接口预留 `decider?:` |
| **盘中分时价格纹理（节点间价格不同）** | ❌缺失 | 仅 `getDailyKlines`，无分钟/tick 源（子agent亲核 tencent/fixture history provider） | **硬阻塞**：节点同价 |
| **统一逐节点复盘报告（决策表+统计+P&L+图+亮点/改进）** | ❌缺失 | 仅 console scorecard+JSON；`report-generation.ts` 非接地 | 见 [review-grounding.md](review-grounding.md) |
| 复盘数字接地（日盈亏/已实现vs浮动/北京时间/胜率） | ❌缺失（编） | 全 `src/` 搜 sharpe/年化零命中（[review-grounding.md](review-grounding.md) §2） | 防幻觉契约缺位 |
| 走势 ASCII 图 | ❌缺失 | 无渲染器，且无分时数据可画 | 依赖分时源 |

**总判**：老板看到的那份 openclaw 样本 = **叙述式幻觉，secretary 既未实现也不该照抄**。它的接地等价物 = **节点回放骨架 + 纸面手 + 账本已全在（~80%）**，卡在三件事：①**分时行情数据源（硬阻塞）**；②**接地复盘事实包 + 报告生成器 + 数字校验器**；③（加分）**把大脑接成回放 decider**，让模拟变成"真 agent 跑一天"而非确定性桩。

## 4. 待办 / 改造建议（按优先级）

**方法取向（贴合老板"用 agent/harness 而非纯代码"的要求，借 openclaw 原语）**：
- 别新写一个庞大 `simulateTradingDay()`。secretary 的 daemon 本身**就是** openclaw 意义上的「standing order（SOP=授权范围/审批门）+ cron（闹铃矩阵=定时）」。**交易日模拟 = 同一条常驻 standing-order 回路，把 wall-clock 换成 `SimulatedClock`、把实时行情换成 as-of 历史源**——复用而非重造。
- 接地纪律 = openclaw 的 **Execute-Verify-Report** + secretary 自己的 review-grounding P0：眼/小脑确定性算死每个数，脑只接收，渲染后 **grep 每个数字回事实包**对不上就打回（openclaw 的 validate-before-accept / before-finalize 钩子）。
- 产物落 `memory/reviews/<date>/replay-review.md`，一日一文件 + 索引——对齐 openclaw `workspace/memory/logs` 与本仓「一文件一事实 + MEMORY 索引」习惯。

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| **P0 拍板** | **分时行情源 A/B/C 选型**：A 新增分钟级 provider（腾讯 `web.ifzq.gtimg.cn` 分时/分钟K、新浪分时）→ 真实节点价；B 先不接分时，复盘锚到当日 OHLC（诚实粗粒度，不编分钟价）；C fixture 内置分时供回测/测试 | 新 `src/infrastructure/providers/*-minute-provider.ts` 或 history provider 扩 `getMinuteKlines`；barrel | 老板拍板（粒度 vs 工作量） |
| P0 | **复盘事实包 `build复盘FactPack(date)`**：确定性算 昨→今资产/日盈亏/日涨幅/已实现vs浮动/逐笔北京时间线/仓位（直接复用 [review-grounding.md](review-grounding.md) 的 P0） | 新 `src/app/build-review-factpack.ts`；读 `calculations.ts`、trades.jsonl、`archive-daily-snapshot.ts` | 北京时间 util(batch10) |
| P0 | **逐节点复盘报告生成器**：事实包 → 决策表(时间·价·涨跌·决策·操作·理由) + 操作统计 + 日 P&L + (分时则画图) + 亮点/改进；**模型只写"亮点/改进"散文**；数字校验器拒幻觉；写 `memory/reviews/<date>/` | 新 `src/app/replay-review-report.ts`；接 `report-generation.ts` | 事实包 + 分时选型 |
| P1 | **把大脑接成回放 decider**：`runBrainAgentTurn`（带 `paper_buy/paper_sell` 手）作为每节点决策者，在 `SimulatedClock`+as-of 价下跑——让模拟是"真 agent 决策+真纸面成交"，与实盘同一回合循环 | `replay-decider.ts`、`run-brain-agent.ts`、回放编排 | 分时(可选) |
| P1 | **行情相位标签** call_auction/open/intraday（让 9:15 竞价价 ≠ 9:30 开盘价 ≠ 盘中价有语义） | quote/minute provider、`src/domain/market/*`（与 [board-judgment-chain.md](board-judgment-chain.md) P0 同源，注意撞车） | 分时源 |
| P1 | **复盘 → 自进化回路接线**：把事实包/已平仓决策喂 `score-replay.ts`/`distill-experience.ts`/`distill-daily-knowledge.ts`（自进化线已存在），让每次模拟沉淀教训+规则提案 | 上述各 distill 文件 | 事实包 |
| P2 | ASCII 走势图渲染器（需分时）；逐笔理由 `trade→intentId→proposal.rationale` join 读回（缺写"未记录"禁编）；日存指数快照算超额 | `equity-curve.ts`、`brain-agent-tools.ts`、`archive-daily-snapshot.ts` | 分时 / review-grounding P1 |

## 5. 开放问题 / 信息缺口（本会话未亲自核验，勿当结论）

- **secretary 侧所有 `src/` file:line 均来自本会话的三个探查子 agent，未逐行亲核**（replay-runner / replay-snapshot / replay-decider / score-replay / walk-forward / simulated-clock / paper-broker / execute-pending-order / cerebellum-daemon 的 `runReplayDay` 行号）。动这些文件前请先 Read 确认。**本会话亲自 Read 的只有**：本目录各 .md（review-grounding / board-judgment-chain / strategy-knowledge-base / alarm-schedule-coverage / README / _TEMPLATE / _MERGE-PROMPT）与 openclaw 的 README/standing-orders/agent-runtime-architecture/automation 目录清单。
- **`--replay-day` 现状产物到底输出什么**：子 agent 称是逐节点告警+漏斗摘要（截断 500 字），非统一复盘；本会话未亲跑确认。
- **分时数据源可用性全未实测**：腾讯/新浪分钟接口的 URL、字段、限频、GBK、历史可回溯天数，全部未验证，是 P0 选型 A 的前提。
- **T+1 跨日卖出是否真平仓**：与 [board-judgment-chain.md](board-judgment-chain.md) §5 / [strategy-knowledge-base.md](strategy-knowledge-base.md) §5 同一悬案，复盘"已实现盈亏"依赖它，落地前必须 `/verify`。
- **openclaw 那份 `full_trading_simulation.md` 的精确生成链**（哪个 skill / cron / prompt 触发、是否真有任何数据输入）本会话只从 harness 原语推断为"叙述式"，未在 openclaw 运行时家目录里抓到该文件本体核对。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- 新增：`src/app/build-review-factpack.ts`（P0 核心，与 [review-grounding.md](review-grounding.md) 共用）、`src/app/replay-review-report.ts`（报告生成器）、`src/infrastructure/providers/*-minute-provider.ts`（分时源）
- `src/runtime/replay-runner.ts`、`scripts/dev/cerebellum-daemon.ts`（`runReplayDay`）—— 回放编排（接大脑 decider 会动）
- `src/app/replay-decider.ts`、`src/app/run-brain-agent.ts`、`src/app/brain-agent-tools.ts`（**共改热点**，见 _MERGE-PROMPT）—— 大脑当 decider
- `src/app/replay-snapshot.ts`、`src/infrastructure/providers/tencent-history-provider.ts`、`fixture-history-provider.ts`、`src/infrastructure/providers/index.ts`(barrel，**收口热点**) —— as-of 价 + 分时
- `src/app/report-generation.ts`、`src/app/daily-fills-ledger.ts`、`src/app/archive-daily-snapshot.ts`、`src/app/equity-curve.ts` —— 复盘事实底座
- `src/app/score-replay.ts`、`src/app/distill-experience.ts`、`src/app/distill-daily-knowledge.ts` —— 模拟 → 自进化接线
- `src/domain/market/*`、`src/domain/cerebellum/*` —— 相位标签 / 节点（与 board-judgment-chain 撞车，串行）

## 7. 扩展构想（基于理解，超出字面需求）

1. **反事实/锦标赛回放（agent fan-out）**：同一历史日、同一组真实价，并行跑 N 个 decider 变体（现脑 vs 更激进止盈 vs 更严止损），各自打分 → 量化"如果当时多止盈会怎样"。把样本里手挥的"10:00 可更多止盈"从拍脑袋变成**实测反事实**。天然是一个 Workflow/judge-panel 扇出。
2. **模拟 vs 实盘一致性校验（给模拟本身上 Execute-Verify-Report）**：对一个既跑过实盘又能回放的日子，diff 接地事实包 与 当日真实成交账本 → 抓漂移、自证模拟忠实，防"回放也开始编"。
3. **走查式多日训练复盘**：自进化线已有 walk-forward，逐日吐人读复盘 + 窗口聚合 equity/胜率曲线，做成"训练 run 报告"（接地）。
4. **命名策略归因**：每个节点决策挂 strategy_id（[strategy-knowledge-base.md](strategy-knowledge-base.md) 桥接方案 B），复盘里显示"哪条策略触发、它历史胜率、今天对没对" → 直接喂提拔/淘汰闭环。
5. **standing-order 式模拟 skill**：把整链封成 secretary skill/CLI（`replay-review --date YYYY-MM-DD`），对齐 openclaw SKILL.md + cron——老板可按需触发或排程（如 21:00 distill 自动吐当日接地复盘）。
6. **诚实置信牌（防幻觉契约延伸）**：小样本不显示"胜率100%"（1 笔交易）、只有日线时不画分钟图而明示"粒度=日线"，把数据粒度与样本量的局限直接印在报告里。
</content>
</invoke>
