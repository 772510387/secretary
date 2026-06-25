# 行情数据源矩阵（粒度×时间跨度，含付费口径）：当日分时免费、历史只要时/日/周/月、周月K白捡、60min历史有免费+付费两条路

> 落盘时间：2026-06-25　会话标识：market-data-source-matrix

## 1. 本会话探查范围

承接 [intraday-minute-data-source.md](intraday-minute-data-source.md)，但**老板当场收缩了范围**（已存记忆 market-data-granularity-scope）：**历史不要分钟级（数据量太大），能判趋势即可——小时(60min)看能否取历史 + 日K/周K/月K（本就有历史）；分时只看当日；付费口径也要一并构建好以便直接接入**。本会话据此重做数据源矩阵：按「粒度 × 当日/历史」列出免费源 + 付费源 + 接进 secretary 的改动量，带 file:line / curl实测 / 官方文档 证据。

## 2. 关键发现（必须带证据）

### 2a. 周K / 月K：同一个腾讯端点白捡，只差一个周期 token（本会话 curl 实测，2026-06-25）

- 日K：`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600000,day,,,5,qfq` → `{"data":{"sh600000":{"qfqday":[["2026-06-17","9.480","9.240","9.550","9.220","771904.000"],…]}}}`（`[日期,开,收,高,低,量]`，带历史）。
- 周K：同端点 `…,week,,,5,qfq` → key 变 **`qfqweek`**，返回 5 根周线（含 2026-05-29…06-25）。
- 月K：同端点 `…,month,,,5,qfq` → key 变 **`qfqmonth`**，返回月线回溯到 2026-02。
- → **日/周/月K 历史全部免费可取，且就是 secretary 已在用的那个端点**。当前代码把周期 token 写死成 `"day"`（[tencent-history-provider.ts:89](../../src/infrastructure/providers/tencent-history-provider.ts#L89)），解析器只认 `qfqday`/`day` 两个 key（[:196-206](../../src/infrastructure/providers/tencent-history-provider.ts#L196-L206)），payload 类型也只声明 `day`/`qfqday`（[:42-45](../../src/infrastructure/providers/tencent-history-provider.ts#L42-L45)）。→ 周/月K 接入 = **参数化周期 token + 解析器认 `qfqweek`/`qfqmonth` + schema 加档**，小改。
- 60min（小时）K 走腾讯 mkline：本会话再次实测 **301**（`…/appstock/app/kline/mkline?param=sh600000,m60,,32`）→ 腾讯免费小时历史这条路本会话没打通（见 §5）。

### 2b. 60min（小时）历史：免费有 BaoStock，付费有 Tushare（官方文档，未在 secretary 内实测）

- **BaoStock 免费、无需注册、深历史**：`query_history_k_data_plus` 的 `frequency` 支持 `d/w/m/5/15/30/60`；**60分钟K 数据范围 1999-07-26 至今，完全免费**；`start_date` 缺省取 2015-01-01；分钟线字段 `date,time,code,open,high,low,close,volume,amount,adjustflag`（[baostock 官方文档](https://www.baostock.com/mainContent?file=stockKData.md)）。**注意：是 Python 库，非 HTTP**——接 secretary 需 Python 子进程桥（仓里已有同型 pattern，见 2d）。
- **AkShare 免费（东财源）**：`stock_zh_a_hist_min_em` 的 `period` 支持 1/5/15/30/60；但 **1分钟只回最近 5 个交易日**，5/15/30/60 分钟历史更长；同为 Python 库（[AkShare 文档](https://akshare.akfamily.xyz/)）。
- **Tushare Pro 付费（HTTP，TS 友好）**：`stk_mins` 支持 1/5/15/30/60min，单次最多 8000 行，循环可取 10+ 年历史，字段 `ts_code,trade_time,open,high,low,close,vol,amount`（[Tushare stk_mins](https://tushare.pro/document/2?doc_id=313)）。**有 HTTP RESTful API**（POST JSON 到 `api.tushare.pro`），不依赖 Python SDK → 可直接在 secretary(TS) 里调。

### 2c. 付费口径（Tushare 积分/权限，官方 [积分对应表](https://tushare.pro/document/1?doc_id=290) WebFetch 实读）

- **积分档**（管的是日线及普通接口，**不含分钟**）：120 分 = 仅非复权日线、50次/分、8000条/日；2000 分 = 普通接口、200次/分；5000 分 = 常规数据不限量 + 特色数据；10000 分 = 特色数据不限量。
- **分钟权限是单独付费、与积分无关**：**历史分钟（1/5/15/30/60min）= 2000 元/年**，500次/分，单次 8000 行；实时分钟 = 1000 元/月，500次/分，单次 300 只。
- 积分获取：注册送≈120；日常购买 200 元 = 2000 积分（1:10，**但分钟数据不在积分范围**）；社区贡献/会员群另计。
- → **想直接接入历史小时K 的最省心付费路 = Tushare「历史分钟权限」2000 元/年**，覆盖 60min（及 1/5/15/30），HTTP 直连 TS。若只要日/周/月K，免费腾讯已够，**无需付费**。

### 2d. 接入侧现状（本会话亲读 + 既有结论）

- **领域 schema 把粒度焊死日线**：`klinePeriodSchema = z.enum(["1d"])`、KlineBar `.strict()` 无时间字段（[schemas.ts:72](../../src/domain/market/schemas.ts#L72)、[:74-89](../../src/domain/market/schemas.ts#L74-L89)）。加周/月/小时档要改这里（高冲突，见 §6）。
- **回放唯一取价接缝按"日"取收盘**：`AsOfMarketReader` 价=`lastBar.close`、只挂 `tradeDate`、无 time-of-day（[asof-market-reader.ts:118-119](../../src/app/asof-market-reader.ts#L118-L119)、[:26-34](../../src/app/asof-market-reader.ts#L26-L34)）。**好消息**：历史既然只要日/周/月/小时趋势、不要盘中逐格，这个"按日/按 bar 取收盘"的接缝**基本够用**，不必为历史改它。
- **已有 Python 子进程桥 pattern**（可复用于 BaoStock/AkShare 数据子进程）：`TradingAgentsCnSubprocessRunner` 走 spawn + stdin JSON + stdout `SECRETARY_RESULT_JSON:` 协议（[trading-agents-cn-subprocess-runner.ts:74-120](../../src/infrastructure/providers/trading-agents-cn-subprocess-runner.ts#L74-L120)、[:216](../../src/infrastructure/providers/trading-agents-cn-subprocess-runner.ts#L216)）。**但那个桥是 research 专用、且 `allowNetwork:false`/`allowBroker:false`/strip 持仓**（[:245-248](../../src/infrastructure/providers/trading-agents-cn-subprocess-runner.ts#L245-L248)、[:412-432](../../src/infrastructure/providers/trading-agents-cn-subprocess-runner.ts#L412-L432)）——**不能直接拿来当数据管**，要新建一个数据用子进程（允许联网取行情）。

## 3. 现状判定（逐能力点）

| 粒度 / 时间 | 状态 | 源（依据） | 接 secretary 改动量 |
|---|---|---|---|
| 当日 分时(1min) | ✅可做(免费) | 腾讯 `minute/query`（[intraday-minute-data-source.md](intraday-minute-data-source.md) 实测） | 新分时 provider + 当日录制（仅当日需要） |
| 历史 60min(小时) | ✅可做 | BaoStock 免费(1999-至今,[官方](https://www.baostock.com/mainContent?file=stockKData.md)) / AkShare 免费 / Tushare 付费2000元/年 | 免费=Python数据子进程；付费=TS直连HTTP |
| 历史 日K | ✅已实现 | 腾讯 `fqkline param=…,day`（已在用，[tencent-history-provider.ts:61](../../src/infrastructure/providers/tencent-history-provider.ts#L61)） | 无 |
| 历史 周K | ✅可做(免费) | 腾讯 `…,week`→`qfqweek`（**本会话实测**） | 周期 token + 解析 key + schema 档 |
| 历史 月K | ✅可做(免费) | 腾讯 `…,month`→`qfqmonth`（**本会话实测**） | 同上 |
| 历史 分钟(1min) | ⚪不做(老板) | 量大、无必要（[memory] market-data-granularity-scope） | — |
| schema 支持 周/月/小时 档 | ❌缺失 | `klinePeriodSchema=enum(["1d"])`（[schemas.ts:72](../../src/domain/market/schemas.ts#L72)） | 加档 + 周期字段 |
| 数据用子进程桥（可联网） | ❌缺失 | 现有桥 research专用+断网（[runner:245-248](../../src/infrastructure/providers/trading-agents-cn-subprocess-runner.ts#L245-L248)） | 新建（仅当走 BaoStock/AkShare 时需要） |
| Tushare HTTP provider(TS) | ❌缺失 | 官方有 HTTP API（[Tushare](https://tushare.pro/document/2?doc_id=313)） | 新 provider，TS 直连，无 Python |

**总判**：收缩范围后，**没有任何硬阻塞**。日K已接；**周/月K 免费、就是现有端点换 token，小改**；**60min 历史有免费(BaoStock,需Python桥)与付费(Tushare,TS直连HTTP,2000元/年)两条路**；当日分时免费（仅当日）。历史既不要分钟，回放取价接缝(按 bar 收盘)基本够用，不必大改。数据量担忧消解：60min=每日仅4根，十年≈不到1万根/股。

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| ~~P0 拍板~~ ✅已定 | **老板拍板：历史 60min 走免费 BaoStock**（Python 子进程，复用 research venv，[research-runner-factory.ts:45-62](../../src/app/research-runner-factory.ts#L45-L62) 同型）。日/周/月K 免费腾讯，当日分时免费腾讯——全链零数据成本。**前置阻塞**：BaoStock 服务器可达性需先实测（本沙箱代理可能连不上，见 [memory] ashare-data-sources，须在真实部署验） | — | ✅ |
| P0 | schema 加周期档：`klinePeriodSchema` 加 `"1w"/"1mo"`（+ 视需要 `"60m"`）；按粒度命名而非塞日线 | [schemas.ts](../../src/domain/market/schemas.ts)（**与 board-judgment-chain 共改 market，高冲突，串行**） | — |
| P0 | 腾讯 provider 支持周/月K：周期 token 参数化 + `selectTencentKlineRows` 认 `qfqweek`/`qfqmonth` + payload 类型加字段 | [tencent-history-provider.ts:42-45](../../src/infrastructure/providers/tencent-history-provider.ts#L42-L45)、[:89](../../src/infrastructure/providers/tencent-history-provider.ts#L89)、[:196-206](../../src/infrastructure/providers/tencent-history-provider.ts#L196-L206) | schema 档 |
| P1 | 大脑/复盘上下文喂"多周期趋势"：日/周/月（+可选60min）的趋势标签进 alarm SOP/快照，支撑"日趋势/月趋势"研判 | `src/app/replay-snapshot.ts`、`src/app/build-context.ts`、cerebellum SOP | provider+schema |
| P1（若选付费） | Tushare HTTP provider：POST `api.tushare.pro`，`stk_mins`/`pro_bar`，token 走 env（脱敏复用现有 redact），实现 `getHourlyKlines` 等 | 新 `src/infrastructure/providers/tushare-provider.ts`、barrel [index.ts](../../src/infrastructure/providers/index.ts) | Tushare 权限购买 |
| P1（若选免费60min） | BaoStock/AkShare 数据子进程：复用 spawn+JSON 协议，但**允许联网取行情**（与 research 桥隔离） | 新 `src/infrastructure/providers/baostock-subprocess-*.ts` + Python 脚本 | Python 环境 |
| P2 | 当日分时录制器（仅当日，给 live 复盘真实节点价；历史无需） | 新 `src/app/intraday-recorder.ts`、daemon tick | — |

### 4b. 实施顺序与验证优先（留给实施会话；本会话只记录，不动代码）

**先验后排（一票否决）**：
- **V1 BaoStock 可达性 + 数据形状**：在 research venv `pip install baostock`，跑 `bs.login()` → `query_history_k_data_plus(code,"date,time,open,high,low,close,volume,amount",start,end,frequency="60",adjustflag="2")` 取 1 只票的 60min + 日/周/月。**本沙箱代理可能连不上 baostock（见 [memory] ashare-data-sources），可能只能在真实部署验**。连不上 → 整条 BaoStock 路要换运行环境，必须先定论再排期。
- **V2 口径**：60min `time` 字段格式（BaoStock 为 `YYYYMMDDHHMMSSsss` + 收盘时刻语义）、`adjustflag` 与腾讯 `qfq` 对齐、每天几根/竞价是否计入。

**依赖链 / worktree**：
```
Task1(market schema 加 1w/1mo/60m+barTime，打底) ─→ Task2(腾讯周/月K) ┐
                                                 └─→ Task3(BaoStock 60min) ┘─→ Task4(收口: build-context/snapshot/barrel 多周期趋势)
```
- Task1 最先落（[schemas.ts](../../src/domain/market/schemas.ts) 高冲突，board-judgment-chain 同改 market，统一收这）；Task2(腾讯文件)与 Task3(baostock 新文件)不撞可并行；Task4 动 barrel+build-context，最后单独串行收口。
- Task3 复用 research venv 子进程模式（[research-runner-factory.ts:45-62](../../src/app/research-runner-factory.ts#L45-L62)），但**新建 data-shaped、允许联网的 runner**（勿复用 research 桥：它 `allowNetwork:false`+strip 持仓）；遵守 [2026-06-16 ADR](../../docs/architecture/decision-records/2026-06-16-tushare-akshare-provider-evaluation.md) 的 throttle/熔断/缓存键(`baostock:60m:symbol:date:adjust`)/降级腾讯/stderr脱敏，并补一条 ADR 增补（该 ADR 未评估 BaoStock）。
- 测试：默认 fake-subprocess/fixture/mock；真数据走显式 `BAOSTOCK_NETWORK=1`/`HISTORY_NETWORK=1`；不破现有基线、不碰主板交易限制/broker。

## 5. 开放问题 / 信息缺口（本会话未验证，勿当结论）

- **腾讯免费 60min 历史端点**：mkline 两次实测 301 / 只回 qt 块，正确 path/param 未打通；是否存在能免费取历史小时K的腾讯端点，未定论（不影响结论，BaoStock/Tushare 已覆盖）。
- **BaoStock / AkShare 的结论来自官方文档与文档站，未在 secretary 内实跑**：60min 实际可回溯起点、停牌/复权处理、限频、与腾讯日K的口径一致性（前复权对齐）需落地时实测。
- **Tushare HTTP 的确切请求/响应 shape、token 申请与「历史分钟权限」开通流程**本会话未亲测（只读了文档的字段与价格）；2000元/年是否含 60min（文档列"历史分钟1/5/15/30/60min"为同一权限，倾向含，但未实测购买确认）。
- **周/月K 的复权对齐**：腾讯 `qfqweek`/`qfqmonth` 是前复权，与现有 `qfqday` 一致，但跨周期拼接做趋势时是否需统一基准未验。
- **secretary 是否愿引入 Python 运行时依赖**（BaoStock/AkShare 路）vs 纯 TS（Tushare HTTP 路）——这是 P0 拍板的隐含前提，未与老板确认。
- 本会话**未读** `src/app/replay-snapshot.ts`、`src/app/build-context.ts` 函数体，P1"多周期趋势喂上下文"落地前需 Read 确认注入点。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- [src/domain/market/schemas.ts](../../src/domain/market/schemas.ts) — 周期档（**高冲突**：board-judgment-chain 的相位/板块、intraday-minute 的盘中 bar 都改 market，需统一收口）
- [src/infrastructure/providers/tencent-history-provider.ts](../../src/infrastructure/providers/tencent-history-provider.ts) — 周/月K 周期 token + 解析 key
- 新增（二选一）：`src/infrastructure/providers/tushare-provider.ts`（付费 HTTP，TS）/ `baostock-subprocess-*.ts`+Python（免费 60min）
- [src/infrastructure/providers/index.ts](../../src/infrastructure/providers/index.ts)（barrel，**收口热点**）
- `src/app/replay-snapshot.ts`、`src/app/build-context.ts` — 多周期趋势注入
- `src/app/asof-market-reader.ts` — 历史取价接缝（结论：基本够用，历史不需大改）
- 相邻文档：[intraday-minute-data-source.md](intraday-minute-data-source.md)（当日分时/代码接缝细节）、[trading-day-simulation.md](trading-day-simulation.md)（复盘总盘）
</content>
</invoke>
