# 盘前"早盘观点/有啥大事"（9:15 前）现状审计与改造方向

> 落盘时间：2026-06-25　会话标识：pre-market-brief

## 1. 本会话探查范围
对照需求文档里"盘前行为（9:15 前）/早盘观点有啥大事"那份样例早报（大盘指数、成交量、涨跌家数、涨停/跌停家数、热点板块、连板梯队、隔夜外盘大事），逐条核对 secretary 现有代码到底实现到哪一步。重点是盘前三个节点 `overnight_digest`(08:15) / `pre_market_plan`(08:30) / `call_auction_watch`(09:15) 喂给大脑的确定性数据有哪些、缺哪些。只看"眼/小脑"层的数据覆盖面，不评价模型输出质量。

## 2. 关键发现（带证据）

- **闹钟→大脑这条链是"确定性数据预喂 + SOP 约束 + 只读"**，骨架完整：`runAlarmNodeAnalysis` 把 SOP + 剑盾框架 + 观察池概览 + 逐持仓影响 + 操作汇报格式 + 推送约束拼成 prompt，模型只读不下单。证据 [src/app/alarm-brain.ts:107-146](../../src/app/alarm-brain.ts#L107-L146)。
- **盘前两个新闻节点会强制逐持仓评估利好/利空**：`HOLDING_IMPACT_NODES = {overnight_digest, pre_market_plan}`。证据 [src/app/alarm-brain.ts:54-58](../../src/app/alarm-brain.ts#L54-L58)、[L117-123](../../src/app/alarm-brain.ts#L117-L123)。
- **`overnight_digest` 的 SOP 本身不要求任何确定性行情数据**，只允许"汇总已有的隔夜 research/report 元数据"，并明令禁止编造新闻/政策/板块。也就是说"隔夜大事"完全依赖注入的 webSearch 上下文，SOP 层没有结构化数据要求。证据 [src/domain/cerebellum/alarm-sop.ts:124-134](../../src/domain/cerebellum/alarm-sop.ts#L124-L134)。
- **每个节点的联网检索词是确定性硬编码的**（不交给模型/标签）：08:15 查隔夜美股/A50/外盘/政策；08:30 查主线题材/热点板块/龙头；09:15 查涨停/一字板/连板/情绪。证据 [src/domain/cerebellum/search-query.ts:25-28](../../src/domain/cerebellum/search-query.ts#L25-L28)。
- **联网检索是后端执行、作为只读上下文注入大脑，不是模型可调用的工具**：`buildBridgeContext` 内调 `maybeWebSearch`，结果作为 `webSearch` 字段传进 `runAskOnce`。证据 [scripts/dev/build-context.ts:124](../../scripts/dev/build-context.ts#L124)、[L634](../../scripts/dev/build-context.ts#L634)、[src/app/alarm-brain.ts:159](../../src/app/alarm-brain.ts#L159)。
- **市场宽度（涨停/跌停/涨跌家数）是确定性算出来的**，按板块阈值（主板 9.8 / 科创创业 19.5 / 其他 29.5）统计，缺 `changePct` 时返回 null + note 不编造。证据 [src/domain/market/theme-heat.ts:17-24](../../src/domain/market/theme-heat.ts#L17-L24)、[L66-102](../../src/domain/market/theme-heat.ts#L66-L102)。
- **代码自己注明：这只是基于 changePct 的涨停判定，不是真·一字板，也没有封单数据**。证据 [src/domain/market/theme-heat.ts:83-89](../../src/domain/market/theme-heat.ts#L83-L89)。
- **行业（板块）数据源已经落地**，子代理早先"完全无行业字段"的说法是过时的：东财 universe 已抓 `f100=所属行业`，UniverseStock 有 `sector` 字段。证据 [src/infrastructure/providers/eastmoney-universe-provider.ts:61-62](../../src/infrastructure/providers/eastmoney-universe-provider.ts#L61-L62)、[L313](../../src/infrastructure/providers/eastmoney-universe-provider.ts#L313)、[src/domain/market/screener.ts:26-27](../../src/domain/market/screener.ts#L26-L27)。
- **"热门板块龙头"分类是实际开着的、并进早报概览**：`categorizeUniverse` 在 `hotSectorLeaderTarget>0` 时调 `findSectorLeaders`（板块内≥2 只强势股则该板块算热门，取成交额最大者为龙头），默认 target=10，且属于会被点名的 NAMED_BUCKETS。证据 [src/domain/market/pool-categories.ts:181-186](../../src/domain/market/pool-categories.ts#L181-L186)、[L211-232](../../src/domain/market/pool-categories.ts#L211-L232)、[L81](../../src/domain/market/pool-categories.ts#L81)、[L241](../../src/domain/market/pool-categories.ts#L241)。生产调用点未显式传该参数，故走默认 10：[src/app/build-watchlist.ts:200-207](../../src/app/build-watchlist.ts#L200-L207)。
- **代码注释与实现自相矛盾**：[pool-categories.ts:9-10](../../src/domain/market/pool-categories.ts#L9-L10) 写着 `hot_sector_leader`"intentionally NOT produced here yet"，但 L181-232 已经实现并产出。注释是陈旧的，需更正以免误导。
- **连板只有"昨日涨停"这一层，没有真·连板计数**：`categorizeUniverse` 接收 `yesterdayLimitUpSymbols` 标记昨日涨停桶；每日涨停快照由 `writeLimitBoardSnapshot`/`readYesterdayLimitBoard` 落盘读取。但全仓 grep `consecutive|streak|连板` 在 build-context 内无任何连板天数计算逻辑。证据 [src/domain/market/pool-categories.ts:62-65](../../src/domain/market/pool-categories.ts#L62-L65)、[L168-179](../../src/domain/market/pool-categories.ts#L168-L179)、[scripts/dev/build-context.ts:223](../../scripts/dev/build-context.ts#L223)、[L310](../../scripts/dev/build-context.ts#L310)、[L459](../../scripts/dev/build-context.ts#L459)、[L483](../../scripts/dev/build-context.ts#L483)。
- **指数只有 4 个**：上证综指、深成指、创业板指、科创50；无沪深300/中证500。证据 [src/infrastructure/providers/tencent-index-provider.ts:30-35](../../src/infrastructure/providers/tencent-index-provider.ts#L30-L35)。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 大盘指数（上证/深证/创业板/科创50） | ✅已实现 | tencent-index-provider.ts:30-35 | 无沪深300/中证500 |
| 涨跌家数（上涨/下跌） | ✅已实现 | theme-heat.ts:21-24 | 缺 changePct 则 null |
| 涨停/跌停家数 | ✅已实现 | theme-heat.ts:17-20, 66-102 | 按板块阈值；非真一字板/无封单 |
| 热点板块·龙头识别 | 🟡部分 | pool-categories.ts:181-232; eastmoney…:61-62; screener.ts:26-27 | 有 f100 一级行业+龙头识别并入概览；**无板块涨幅榜排名、无杀跌板块、无概念板块** |
| 连板梯队（N连板+名单） | 🟡部分 | pool-categories.ts:62-65,168-179; build-context.ts:223,310,459,483 | 仅"昨日涨停"标记，**无连板天数计算** |
| 隔夜外盘/早盘大事 | 🟡部分 | search-query.ts:25-28; build-context.ts:124,634; alarm-brain.ts:159 | 有后端 Tavily 注入，但**原始 snippet、未结构化/未核查/未去重** |
| 全市场成交量/缩放量 | ❌缺失(待确认) | — | 未在代码中找到全市场成交额聚合与同比；见第5节 |
| 一字板 / 封单额 | ❌缺失 | theme-heat.ts:83-89 | 代码明确注明无盘口/封单数据源 |
| 100池 9:15 换血 | 🟡部分(待确认) | — | 子代理称 call_auction_watch 在 REFRESH_POOL_NODES，本会话未亲自核 cerebellum-daemon.ts |

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 连板天数计算：今涨停∩昨涨停→streak=昨+1，落盘 `consecutiveDays`，生成"4连板:X/3连板:Y"梯队注入 poolOverview | scripts/dev/build-context.ts、src/domain/market/pool-categories.ts | 已有 limit-board 快照，纯小脑，零模型、零下单 |
| P0 | 更正 pool-categories.ts:9-10 陈旧注释（hot_sector_leader 实际已产出） | src/domain/market/pool-categories.ts | 无 |
| P1 | 板块涨幅榜：在 f100 基础上按板块聚合平均涨跌幅+资金，输出"煤炭+X%/半导体−Y%"排名（含杀跌板块），而非只给龙头 | src/domain/market/theme-heat.ts（或新 sector-heat 模块）、build-context.ts | 复用现有 f100；需先实测 f100 覆盖率 |
| P1 | 全市场成交额聚合+同比昨日，产出"X万亿(缩量/放量)"一句 | src/domain/market/theme-heat.ts、scripts/dev/build-context.ts | universe.amount 求和 |
| P1 | 隔夜大事结构化：Tavily 结果去重+按时间/来源排序+截断成 `[{标题,来源,时间,摘要,url}]` 再喂 | scripts/dev/build-context.ts、src/app/ask-portfolio.ts | 现有 maybeWebSearch |
| P2 | （harness 级）给大脑只读按需工具：query_sector_heat / query_limit_streak / web_fetch，让其对一条新闻自行核实；写仍锁在"手" | 新工具层、alarm-sop.ts(allowedActions) | 借 openclaw before_tool_call 审批钩子思路 |
| P2 | （harness 级）"早盘大事"做多源搜→子代理 fetch 原文证伪→多数通过才入早报（对抗新闻幻觉） | 新 verify 流程 | 盘前不赶时间，跑得起 |
| P2 | 概念板块热度（CPO/AI PC 等）数据源 | 新 provider | f100 仅一级行业，覆盖不到概念 |

## 5. 开放问题 / 信息缺口（本会话未亲自查证，勿当结论）
- **全市场成交额聚合/缩放量**：未在代码里找到全市场成交额求和与同比昨日的逻辑，但未穷尽 build-context 全文，"不存在"是初步判断而非定论。
- **f100 行业实际覆盖率**：只确认了抓取与解析链路（fetch→sector→findSectorLeaders→概览），未实跑确认东财返回多少比例的票真带 sector；龙头识别效果取决于此。
- **盘前各节点的确切时间（08:00/08:15/08:30/09:15）与 09:15 换血**：来自子代理报告（alarm-matrix.ts / cerebellum-daemon.ts:314-323 的 REFRESH_POOL_NODES），本会话未亲自打开这两个文件核对。
- **概念板块无源**：推断 f100 是东财一级行业、概念热度无数据源，未在代码中找到反证，待确认。
- **hot_sector_leader 实际进 09:15 推送**：确认了默认 target=10 且会被命名，但未端到端跑一次确认 09:15 那次 refresh 真把龙头写进了 poolOverview。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）
- `scripts/dev/build-context.ts`（连板 streak、成交额聚合、新闻结构化都会动这里——高冲突，注意串行）
- `src/domain/market/pool-categories.ts`（连板、热点板块、注释更正）
- `src/domain/market/theme-heat.ts`（板块涨幅榜、成交额聚合）
- `src/domain/market/screener.ts`（若 sector 相关字段扩展）
- `src/app/build-watchlist.ts`（categorize 调用参数）
- `src/app/ask-portfolio.ts`（新闻结构化上下文、未来只读工具入参）
- `src/domain/cerebellum/alarm-sop.ts` / `search-query.ts`（SOP allowedActions、检索词）
- `src/infrastructure/providers/eastmoney-universe-provider.ts`（行业/概念数据源扩展）
