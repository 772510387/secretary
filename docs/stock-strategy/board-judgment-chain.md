# 盘面判断链（观察→判断→复查闹钟）：现状审计与落地方案

> 落盘时间：2026-06-25　会话标识：board-judgment-chain

## 1. 本会话探查范围

老板给了一套期望展示流：9:15→9:25→9:45→10:00 每个闹钟节点产出一份结构化「盘面判断」——**观察（大盘竞价 / 板块竞价 / 持仓股竞价 / watchlist 异常）→ 判断（大盘情绪 / 主线切换 / 持仓股 / watchlist 机会 / 今日策略）→ 下次复查闹钟（带重点关注）**，并在 10:00 按 -5%/-7% 加仓线执行加仓。本会话目标：逐能力点判定「已实现 / 部分 / 缺失」，并给出 agent/harness 视角（小脑工程化 + 大脑结构化 + 自调度闹钟）的落地序列。板块数据源已由老板拍板走**东财概念板块接口**。

## 2. 关键发现（必须带证据）

- **大盘指数四件套已就绪**：上证/深成/创业板/科创50 现价·涨跌幅·昨收均可抓，腾讯单一源。见 [tencent-index-provider.ts:30-35](../../src/infrastructure/providers/tencent-index-provider.ts#L30-L35)（`sh000001/sz399001/sz399006/sh000688`）。
- **板块数据源被明确推迟、完全没接**：代码注释自承 `hot_sector_leader (needs sector data) is intentionally NOT produced here yet`。见 [pool-categories.ts:9-10](../../src/domain/market/pool-categories.ts#L9-L10)。→ 这是「板块竞价榜 + 主线切换」的硬阻塞。
- **闹钟是写死的静态矩阵，无自调度**：17 个固定闹钟硬编码，9:15 `call_auction_watch`、9:25 `pre_open_confirmation` 都是独立排程，不存在「一个闹钟设定下一个」的复查链。见 [alarm-matrix.ts:18](../../src/domain/cerebellum/alarm-matrix.ts#L18)、[:44](../../src/domain/cerebellum/alarm-matrix.ts#L44)、[:51](../../src/domain/cerebellum/alarm-matrix.ts#L51)。
- **输出是自由文本，非结构化**：推送 `summary` 直接是 `【${title}】\n${ask.answer}` 截断 1000 字；代码里虽有 `structured` 字段但"never shown to human"。见 [alarm-brain.ts:177](../../src/app/alarm-brain.ts#L177)、[:69-75](../../src/app/alarm-brain.ts#L69-L75)。→ 产不出「观察4块/判断5块」的结构化模板。
- **风控只有三条硬线，没有加仓线**：`maxSinglePositionRatio 0.4 / hardStopLossRatio 0.08 / dailyLossLimitRatio 0.03`，全文无 `加仓/addPosition` 命中。见 [risk-engine.ts:291-293](../../src/domain/risk/risk-engine.ts#L291-L293)。→ -5%/-7% 加仓线无规则引擎。
- **持仓/加仓/T+1 的"手"已健全**（来自本会话探查 agent，未逐行复核见 §5）：P&L、仓位%、加仓成本摊薄、T+1 跨日 rollover 均已实现，内存记忆里那条"T+1 卖不出"的 bug 已修。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 大盘指数 现价·涨跌幅·昨收 | ✅已实现 | tencent-index-provider.ts:30-35 | 单一腾讯源，无备援 |
| 集合竞价 vs 开盘 相位区分 | ❌缺失 | 无 `MarketSession` 相位 | 腾讯 qt 在 9:15-9:25 返回的现价即竞价价，缺的是"相位标签"非数据源 |
| 涨跌家数（情绪广度） | 🟡部分 | theme-heat.ts:115（agent 报告，见 §5） | 从全市场 universe 算 advancers/decliners，非竞价时点 |
| 板块竞价表现（强弱榜） | ❌缺失 | pool-categories.ts:9-10 | **载重墙**；走东财概念板块接口补 |
| 持仓股 现价·盈亏·仓位% | ✅已实现 | calculations.ts:204（agent 报告，见 §5） | 竞价价同受相位缺失影响 |
| watchlist 100 池 + 分类 | 🟡部分 | build-watchlist.ts:191（agent 报告，见 §5） | 桶是"涨停/跌停/成交额"，**不是"机器人龙头"题材标签**；无"异常"过滤 |
| 一字板 / 封单金额 | 🟡可补 | theme-heat.ts:90（agent 报告，见 §5） | 判涨停仅靠 changePct≥9.8%；封单≈买一量×涨停价 可解析但解析器没取 |
| 大盘情绪判断 | ✅可做 | — | 大脑已能拿指数+广度 |
| 主线切换判断 | ❌受阻 | 依赖板块数据 | 无板块序列则大脑只能编 |
| 持仓股 加仓线纪律(-5%/-7%) | ❌缺失 | risk-engine.ts:291-293 | 无规则引擎 |
| watchlist 机会 / 今日策略 | ✅可做 | alarm-sop.ts 剑盾框架（agent 报告） | 框架在 |
| 下次复查闹钟（自调度+焦点携带） | ❌缺失 | alarm-matrix.ts:18 | 静态矩阵，无链式 |
| 结构化输出（观察/判断/策略） | ❌缺失 | alarm-brain.ts:177 | 自由文本 |
| 加仓执行（摊薄·仓位·扣现金） | ✅已实现 | paper-broker.ts:417（agent 报告，见 §5） | — |
| T+1 跨日 rollover | ✅已修 | calculations.ts `rollForwardPositionsForTradingDate`（agent 报告） | 旧 bug 已修 |
| 策略胜率 / 主线判断准确率统计 | 🟡部分 | — | 经验反哺有，结构化指标缺；语义检索未插电 |

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 东财概念板块 provider → 板块实时涨跌榜（含降级标记） | `src/infrastructure/providers/eastmoney-sector-provider.ts`(新)、`src/domain/market/*` | 东财接口可用性 |
| P0 | 行情相位标签 `call_auction/open/intraday` | `src/domain/market/`、quote provider | 无 |
| P0 | 节点快照环 + "对比上一节点" delta（这套展示的灵魂） | `src/domain/cerebellum/`、新信封类型 | 上两项 |
| P1 | `BoardJudgment` 结构化输出 schema + 渲染器（替换自由文本） | `src/domain/cerebellum/schemas.ts`、`src/app/alarm-brain.ts`、`src/domain/cerebellum/alarm-sop.ts` | P0 信封 |
| P1 | 加仓线条件反射（小脑算命中 → 信封打标，大脑只判逻辑是否变） | `src/domain/risk/`、信封 `holdings[]` | 持仓估值 |
| P2 | 自调度复查闹钟链 + 重点关注携带（借 openclaw cron-tool） | `src/infrastructure/scheduler/`、`src/domain/cerebellum/alarm-matrix.ts` | P1 结构化 nextReview |
| P2 | watchlist 题材标签化（"机器人龙头"等）+ 异常过滤 | `src/app/build-watchlist.ts`、`src/domain/market/pool-categories.ts` | 板块成分映射 |
| P3 | 封单解析（买一量×涨停价）、加仓线规则记忆化+盘后自修正、BoardJudgment 落库统计胜率 | quote provider、`MEMORY.md`、记忆层 | — |

## 5. 开放问题 / 信息缺口

- **本会话亲自 Read 复核过的 file:line**：tencent-index-provider.ts:30-35、pool-categories.ts:9-10、risk-engine.ts:291-293、alarm-matrix.ts:18/44/51、alarm-brain.ts:69-75/177。**其余带"(agent 报告)"的 file:line 来自本会话的探查子 agent，未逐行亲核**：theme-heat.ts:90/115、calculations.ts:204 及 `rollForwardPositionsForTradingDate`、build-watchlist.ts:191、paper-broker.ts:417、alarm-sop.ts 剑盾框架。后续动这些文件前建议先 Read 确认行号。
- **东财概念板块接口的具体形态未查证**：URL、字段、限频、反爬、是否 GBK、概念命名与老板心智模型（"机器人/玻璃基板/外骨骼机器人"）能否对上——全部未验证，需在 P0 落地时实测。
- **"外骨骼机器人"这类细分分支** 是否在任何板块体系里有现成口径，未知；可能需要自建子题材映射。
- **涨跌家数能否反映"竞价时点"** 未验证：现有 computeThemeHeat 依赖全市场 universe 抓取，竞价阶段该 universe 是否返回竞价价、9:15 预估家数怎么来，未查。
- **语义检索 / memory_write 工具"未插电"** 来自既往审计记忆，本会话未复核当前代码状态。
- **腾讯 qt payload 是否真含买卖五档量价**（用于封单）未在本会话打开解析器确认。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- `src/infrastructure/providers/eastmoney-sector-provider.ts`（新建，板块源）
- `src/infrastructure/providers/tencent-quote-provider.ts`（相位标签、五档解析）
- `src/infrastructure/providers/tencent-index-provider.ts`（指数 delta）
- `src/domain/market/theme-heat.ts`、`src/domain/market/pool-categories.ts`（板块聚合、题材标签）
- `src/app/build-watchlist.ts`（题材标签化、异常过滤）
- `src/domain/cerebellum/schemas.ts`、`src/domain/cerebellum/alarm-matrix.ts`、`src/domain/cerebellum/alarm-sop.ts`（信封、自调度、结构化 SOP）
- `src/app/alarm-brain.ts`、`src/app/ask-portfolio.ts`（信封装配、结构化输出、渲染）
- `src/domain/risk/risk-engine.ts`（加仓线条件反射）
- `src/infrastructure/scheduler/index.ts`（动态复查闹钟）
- `src/domain/portfolio/calculations.ts`、`src/infrastructure/broker/paper-broker.ts`（加仓执行，只读为主，注意与风控会话潜在撞车）
