# 分时（分钟级）行情数据源可行性：方案 A 的接线点与硬限制（免费腾讯端点只给当天，历史日要录制器）

> 落盘时间：2026-06-25　会话标识：intraday-minute-data-source

## 1. 本会话探查范围

承接 [trading-day-simulation.md](trading-day-simulation.md)：老板已选**方案 A（接分钟级 provider，让节点价 9:25/9:45/10:00 各不相同）**。本会话只干一件事——**为 A 验证"分时数据从哪来、怎么接、有什么硬限制"**：① 亲读现有 provider/schema/回放消费侧代码，定位"日线→分钟"要动哪些接缝（带 file:line）；② 实测腾讯分时端点，确认数据格式与**历史可回溯性**。结论先行：**当日分时免费可取且格式干净；但任意历史日（如样本的 2026-06-09）的盘中，本会话实测的免费腾讯端点取不到**——这把 A 劈成「A1 当日实时盘中（现在能做）」与「A2 历史盘中（需录制器或换源）」两件事。

## 2. 关键发现（必须带证据）

### 2a. 代码侧（本会话亲自 Read 核验）

- **`HistoryProvider` 接口只有日线**：`getDailyKlines` + `getDailyTechnicalIndicators`，无任何分钟方法（[tencent-history-provider.ts:13-22](../../src/infrastructure/providers/tencent-history-provider.ts#L13-L22)）。
- **日线端点与腾讯分时同主机族**：日线打 `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get`（[:47](../../src/infrastructure/providers/tencent-history-provider.ts#L47)），URL 参数是 `[symbol,"day","",endDate,count,adjustment]`——`"day"` 是**周期档位**，写死成日线（[:89](../../src/infrastructure/providers/tencent-history-provider.ts#L89)）。`count` 限 1–240（[:208-214](../../src/infrastructure/providers/tencent-history-provider.ts#L208-L214)）——巧的是一个交易日正好 240 根 1 分钟 K。
- **领域模型把粒度焊死在日线**：`klinePeriodSchema = z.enum(["1d"])`（[schemas.ts:72](../../src/domain/market/schemas.ts#L72)）；`klineBarSchema` 是 `.strict()`、只有 `tradeDate`(日期)、**无任何盘中时间字段**（[:74-89](../../src/domain/market/schemas.ts#L74-L89)）；技术指标 schema 的 `period` 同 enum、`asOfDate` 也是日期（[:98-113](../../src/domain/market/schemas.ts#L98-L113)）。→ 要表达分钟 bar，**必须改 schema**（加周期档 + 加 datetime 字段，且因 `.strict()` 不能偷塞）。
- **`AsOfMarketReader` 是回放唯一的 as-of 取价接缝，且按"日"取收盘价**：自述注释 "Prices are the last surviving bar close (there is no live quote provider in replay)"（[asof-market-reader.ts:56-64](../../src/app/asof-market-reader.ts#L56-L64)）；价格 = `lastBar.close`、priceSource=`as_of_close` 且只挂 `tradeDate`（[:118-119](../../src/app/asof-market-reader.ts#L118-L119)）；输入只有 `asOfDate`(日期)+`inclusive`(布尔)，**没有任何 time-of-day 入参**（[:26-34](../../src/app/asof-market-reader.ts#L26-L34)）。
- **回放对盘中节点不区分价**（本会话亲核，纠正 trading-day-simulation §5 的"子agent报告"为已核）：`runReplay` 逐节点把 `SimulatedClock` 钉到 `alarm.beijingTime`（[replay-runner.ts:92](../../src/runtime/replay-runner.ts#L92)），但建快照时传给 reader 的只有 `asOfDate: beijingTime.date` 和一个布尔 `sameDayBarIncluded`（[:101-110](../../src/runtime/replay-runner.ts#L101-L110)）；`asOfTime` 这个 ISO 时刻被记进快照元数据，**不参与选价**。文件顶部注释明说："any intraday node — value at the PRIOR close"（[:15-22](../../src/runtime/replay-runner.ts#L15-L22)）。→ **同一天所有盘中节点现在拿同一个价**，物理上拼不出 9:25≠9:45≠10:00。
- **承载"每节点价"的结构已存在**：`IntradayCheckpoint` 每个闹钟节点存 `holdings[].price` + 指数 `changePct` + 热度，串成当日时间线喂大脑做"上次→本次"对比（[intraday-checkpoint.ts:19-30](../../src/domain/market/intraday-checkpoint.ts#L19-L30)、[:46-65](../../src/domain/market/intraday-checkpoint.ts#L46-L65)）。→ `holdings[].price` 就是真实盘中价的天然落点（现在填的是日收）。
- **Fixture 回放 provider 也只日线**：`FixtureHistoryProvider` 内存日线、honor `endDate`+`count`（[fixture-history-provider.ts:19-44](../../src/infrastructure/providers/fixture-history-provider.ts#L19-L44)）。→ 选项 C（fixture 内置分时）要照此造分钟版。
- **实时 quote provider 只给"此刻"**：`qt.gtimg.cn/q=`、GBK 解码、`~` 切字段拿现价/开/高/低（[tencent-quote-provider.ts:41](../../src/infrastructure/providers/tencent-quote-provider.ts#L41)、[:88](../../src/infrastructure/providers/tencent-quote-provider.ts#L88)、[:144-162](../../src/infrastructure/providers/tencent-quote-provider.ts#L144-L162)）。→ 对**历史**盘中无用；但对"录制当日盘中"或"竞价段(9:15-9:25)现价"有用。

### 2b. 端点实测（本会话 curl 实跑，2026-06-25）

- ✅ **当日分时可取、格式干净**：`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=sh600000` 返回 `{"code":0,"data":{"sh600000":{"data":{"data":["0930 8.85 5104 4517040.00","0931 8.85 19300 ...", ...]}}}}`，每条 = `"HHMM 价 量 额"`，**从 0930 起逐分钟**。这正是 A 要的节点价来源（读 0930/0945/1000… 对应分钟价）。看起来是 UTF-8 JSON（非 quote 那种 GBK）。
- ❌ **免费端点忽略历史日期参数、只回当天**：`.../day/query?code=sh600000&date=20260609` 返回的是 `{"date":"20260625", data:["0930 ...]}`——**date=20260609 被无视，给的是今天(20260625)的分时**。→ 重放样本里的 2026-06-09 这种**过去日**，这条免费路走不通。
- 🟡 **分钟 K（mkline）未验到正确端点**：`web.ifzq.gtimg.cn/.../kline/mkline?param=sh600000,m5,,320` 返回 **301**；换主机 `ifzq.gtimg.cn`（去掉 `web.`）同 path 只回了 `qt` 实时快照块、**没有 m5 分钟 K 序列**。→ 分钟 K 的正确 path/param 本会话没拿到（见 §5）。
- ⚠️ **竞价段(9:15-9:25)不在分时序列里**：实测分时**从 0930 开始**，没有 0915–0929。样本却有 9:15、9:25 两个带价节点。→ 这两个节点的价只能靠**当时的实时 quote**（录制时抓），历史回放无源。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line / 实测) | 备注 |
|---|---|---|---|
| 当日(今天)分钟级价格获取 | ✅可做（免费） | 实测 `minute/query` 返回 `"HHMM 价 量 额"` from 0930 | UTF-8 JSON |
| 任意历史日分钟级价格（免费腾讯） | ❌走不通 | 实测 `day/query?date=20260609` 忽略日期回当天 | A2 的硬墙 |
| 分钟 K（mkline）历史序列 | 🟡未验到 | 实测 301 / 只回 qt 块 | 正确 path/param 待实测 |
| 竞价段 9:15–9:25 盘中价（历史） | ❌缺源 | 实测分时从 0930 起 | 仅能录制时用实时 quote 兜 |
| `HistoryProvider` 支持分钟方法 | ❌缺失 | [tencent-history-provider.ts:13-22](../../src/infrastructure/providers/tencent-history-provider.ts#L13-L22) | 只 getDailyKlines |
| `KlineBar` schema 支持盘中粒度 | ❌缺失 | [schemas.ts:72](../../src/domain/market/schemas.ts#L72)、[:74-89](../../src/domain/market/schemas.ts#L74-L89) | enum 仅"1d"、无时间字段、strict |
| `AsOfMarketReader` 按 time-of-day 选价 | ❌缺失 | [asof-market-reader.ts:26-34](../../src/app/asof-market-reader.ts#L26-L34)、[:118-119](../../src/app/asof-market-reader.ts#L118-L119) | 价=日收、只挂 tradeDate |
| 回放按节点区分盘中价 | ❌缺失 | [replay-runner.ts:15-22](../../src/runtime/replay-runner.ts#L15-L22)、[:101-110](../../src/runtime/replay-runner.ts#L101-L110) | 仅 date+settled 布尔 |
| "每节点价"承载结构 | ✅已有 | [intraday-checkpoint.ts:19-30](../../src/domain/market/intraday-checkpoint.ts#L19-L30) | holdings[].price，现填日收 |
| Fixture 分钟回放（选项 C） | 🟡pattern在 | [fixture-history-provider.ts:19-44](../../src/infrastructure/providers/fixture-history-provider.ts#L19-L44) | 需造分钟版 |
| 实时 quote（录制/竞价兜底用） | ✅已实现 | [tencent-quote-provider.ts:41](../../src/infrastructure/providers/tencent-quote-provider.ts#L41) | 仅"此刻"、GBK |

**总判**：方案 A 的**代码接缝清晰、改动量可控**（schema 加档 + provider 加分钟方法 + as-of reader 加 time-of-day + 回放传 asOfTime 选价），承载结构(IntradayCheckpoint)已就位。**真正的硬约束在数据**：免费腾讯分时**只给当天**，重放过去日的盘中**无现成历史源**。所以 A 的正解不是"实现时顺手抓历史分钟"，而是**先上盘中录制器，把每个交易日的分时实时落盘**，之后才能回放"已录制过的"日子；想回放更早的历史日，得另找/买更深的历史分钟源。样本的 2026-06-09（过去日）在录制器上线前**无法忠实重放**——这点要先跟老板讲清。

## 4. 待办 / 改造建议（按优先级）

**取向（agent/harness，非纯代码）**：把"取分时"做成**录制型 standing-order**而非"回放时现拉"——daemon 已有每分钟 tick 与 3 秒哨兵，天然是录制器宿主；录制落盘后，回放只读本地，确定性、可回归、防反爬。

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| **P0 拍板** | 跟老板对齐 A 的范围：**A1 当日实时盘中（现在能做）** vs **A2 历史盘中（需录制器，且录制上线前的过去日如 2026-06-09 无法忠实重放）**。是否接受"先录制、从今天起的日子才能逐分钟重放" | — | 老板拍板 |
| P0 | **盘中录制器（standing-order）**：daemon tick 内每分钟拉 `minute/query`（持仓+池+指数 sh000001 等），落 `memory/market/intraday/<date>/<symbol>.jsonl`；竞价段(9:15-9:25)用实时 quote 兜 | 新 `src/app/intraday-recorder.ts`、`scripts/dev/cerebellum-daemon.ts` tick、新 memory 目录 | minute/query 限频/编码确认(§5) |
| P0 | **schema 扩展**：`klinePeriodSchema` 加 `"1m"`/`"5m"`；新增 `intradayBarSchema`（带 `time`/`timestamp` 字段）或给 KlineBar 加可选盘中时间字段（保持 strict 显式加） | [src/domain/market/schemas.ts](../../src/domain/market/schemas.ts)（**与 board-judgment-chain 共改 market，高冲突**） | — |
| P1 | **分时 provider + 解析器**：`TencentIntradayProvider.getIntradayBars(symbol, date)` 读录制落盘（线上）/ `minute/query`（当日），解析 `"HHMM 价 量 额"` | 新 `src/infrastructure/providers/tencent-intraday-provider.ts`、barrel [index.ts](../../src/infrastructure/providers/index.ts) | schema |
| P1 | **as-of reader 加 time-of-day 选价**：输入加 `asOfTime`，按 `<= 节点分钟` 取最近分钟价（替代 `lastBar.close`），priceSource 出 `as_of_minute` | [src/app/asof-market-reader.ts](../../src/app/asof-market-reader.ts) | 分时 provider |
| P1 | **回放传 asOfTime 选盘中价**：`runReplay`/`buildReplaySnapshot` 把已记录的 `asOfTime`(replay-runner.ts:100) 透传进 reader 选分钟价，并放宽 `SAME_DAY_BAR_SETTLED_MINUTE` 的"日内一律前收"约束 | [src/runtime/replay-runner.ts](../../src/runtime/replay-runner.ts)、`src/app/replay-snapshot.ts` | 上一项 |
| P2 | **fixture 分钟 provider**（选项 C，测试/回归用）；mkline 历史分钟端点正确 path/param 实测；评估更深历史分钟源（取过去任意日） | [fixture-history-provider.ts](../../src/infrastructure/providers/fixture-history-provider.ts)、provider | — |

## 5. 开放问题 / 信息缺口（本会话未验证，勿当结论）

- **分钟 K（mkline）正确端点/参数/历史深度未验到**：`web.` 主机 301、`ifzq.` 只回 qt 块；是否存在能取"过去任意日全天分钟"的免费腾讯/新浪端点，**未验**（只验了 `day/query` 的 date 参数被忽略）。这是 A2 能否不靠录制器的关键，需专门实测。
- **`minute/query` 的限频 / 反爬 / 历史可回溯天数 / 确切编码**未深验：本会话只成功取了当日一次、目测 UTF-8（非 GBK）；是否需 `readGbkText`、连续高频是否被封、是否能取"昨天/前天"未试。
- **指数(大盘)与板块的分时**是否同 `minute/query`（如 `code=sh000001`）可取、格式同否——未验（录制器要带指数）。
- **竞价段(9:15-9:25)历史价**确认无源（实测分时从 0930 起）：录制时用实时 quote 抓竞价现价是否可行、那两个节点价的语义如何标注——未设计。
- **录制落盘的体量/保留策略**（每日 N 支 × 240 分钟 × 字段）未估算。
- 本会话**未读** `src/app/replay-snapshot.ts` 与 `buildReplaySnapshot` 函数体本身（只读了调用它的 replay-runner）；P1"回放传 asOfTime"落地前需 Read 确认其入参与 reader 调用点。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- 新增：`src/app/intraday-recorder.ts`（录制 standing-order）、`src/infrastructure/providers/tencent-intraday-provider.ts`（分时源+解析）、`memory/market/intraday/`（落盘目录）
- `src/domain/market/schemas.ts` — 周期档 + 盘中 bar（**高冲突**：[board-judgment-chain.md](board-judgment-chain.md) 的相位标签/板块也改 market）
- `src/app/asof-market-reader.ts` — time-of-day 选价（回放取价唯一接缝）
- `src/runtime/replay-runner.ts`、`src/app/replay-snapshot.ts` — 透传 asOfTime、放宽日内前收约束
- `src/domain/market/intraday-checkpoint.ts` — holdings[].price 填真实盘中价
- `src/infrastructure/providers/fixture-history-provider.ts` — 分钟 fixture（选项 C）
- `src/infrastructure/providers/index.ts`（barrel，**收口热点**）、`scripts/dev/cerebellum-daemon.ts`（tick 内挂录制器）
- `src/infrastructure/providers/tencent-quote-provider.ts` — 录制/竞价兜底复用（只读为主）
</content>
</invoke>
