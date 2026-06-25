# 需求对齐清单(合同)

> 基准文档:[`docs/requirements`](./requirements)(1381 行对话记录,非规格)。
> 本文件把它拆成可勾选的离散流程点,作为你我**唯一的对齐基准**。
> 生成于 2026-06-24 的端到端只读审计;证据为审计当时的 `file:line`,实现变动后需复核。

## 怎么用这份合同

1. **你逐条裁决**:每条的「裁决」默认 `☐ 待定`。你按 **条目号 + 决定** 告诉我,三选一:
   - `改代码` —— 把实现改到与文档一致
   - `保现状+改文档` —— 现状是对的,把 `docs/requirements` 更新成实际
   - `视情况` —— 按我给的折中建议
2. **我逐条闭环**:改完给**真实证据**(真跑该节点/重演,展示写了哪个文件、改了哪些 DB 字段、推了哪条 Feishu),不是"我觉得做完了"。
3. **验收动作**:首选 `走一遍 X 日`(重演)逐节点看真实产出 —— 但这依赖先修 INFRA-01/02(否则池子空、全 skip)。

**状态图例**:🟢 实现 · 🟡 半实现 · 🟠 半实现偏空 · 🔴 未实现/真 bug · ✅ 验收通过

> **2026-06-24 夜间施工进度**:在分支 `align/requirements-overnight` 上,按"逐项我拍板+真跑验收"的约定批量实现。
> 14 条已落地并测试(740 测试全绿),5 条按工程判断 保现状+改文档,2 条(MEM-05/07)判定为需设计的特性、留待你定。详见每条「夜间结果」与文末报告。

---

## 0. 基础设施 / 管道(先修,否则无法验收)

### INFRA-01 重演路径不换血 🟡
- **现象**:[`runReplayDay`](../scripts/dev/cerebellum-daemon.ts) 用 `readWatchlist100` 只读磁盘池子,不跑换血(设计成 as-of 忠实,而全市场筛选无历史 as-of 源)。池空→13 节点全 skip "100池为空"。
- **我的建议**:`改代码` —— 给重演加开关「用当日成交额 TOP 换血(明确标注非 as-of)」。否则"走一遍某日"永远验证不了流程,这是验收的前置。
- **验收**:走一遍任一交易日,每个 FUNNEL 节点日志 `watchlist100` 非空。
- **裁决**:☐ 待定

### INFRA-02 联网换血实际拿到 0 支 🔴
- **现象**:[`watchlist_today.json`](../memory/market/watchlists/watchlist_today.json) 当前 `entries:[], universeSize:0`;[`refreshWatchlist100`](../scripts/dev/build-context.ts) 联网拿不到数据就降级覆写成空(Eastmoney/Sina 需网络/代理,见记忆 `NODE_USE_ENV_PROXY`)。
- **我的建议**:`改代码/配置` —— 开网络 opt-in/代理并排查 universe provider;换血失败时**不要覆写**已有池子(避免把好池子写空)。
- **验收**:跑一次实时换血,`watchlist_today.json` 有 100 条、`universeSize>0`。
- **裁决**:☐ 待定

---

## A. 盘前三部曲(08:00 / 08:15 / 08:30 / 09:15)

### PRE-01 08:00 体检:网络冒烟 + 脚本自检 + 读账本 🟡
- **期望**:网络/接口连通性自检 + 脚本冒烟 + 读账本确认资产没丢。
- **现状**:只读了 account/positions 喂大脑;**网络/脚本自检零代码**,SOP 模板还禁止联网。本质是"读数据+让模型说几句"。
- **建议**:`改代码`(补一个确定性 smoke:探接口连通 + 校验账本可读),或 `保现状+改文档`(承认 08:00 只做账本校验)。
- **验收**:跑 08:00 节点,输出里有真实的接口连通/账本校验结果。
- **裁决**:☐ 待定

### PRE-02 08:15 强制搜隔夜外盘(美股/中概/A50/政策)🟡
- **期望**:强制 web_search 美股/中概/**A50**/国内政策。
- **现状**:强制搜 ✅(在 [`NEWS_HEAVY`](../scripts/dev/cerebellum-daemon.ts));但查询词 [`search-query.ts`](../src/app/search-query.ts) **漏 A50**。
- **建议**:`改代码` —— 查询词补 A50。低成本。
- **验收**:跑 08:15,`webSearch` 上下文含 A50 相关检索。
- **裁决**:☐ 待定

### PRE-03 08:15 逐条评估对持仓的影响(利好/利空)🟡
- **期望**:对每只持仓**逐条**给利好/利空判断。
- **现状**:无任何"逐持仓×消息"确定性逻辑,纯靠大模型读 prompt 自由发挥。
- **建议**:`改代码`(把每只持仓显式列入 prompt 并强制逐条结论结构),或 `保现状+改文档`(接受模型自由发挥)。
- **验收**:跑 08:15,输出对每只持仓各有一条利好/利空结论。
- **裁决**:☐ 待定

### PRE-04 08:30 选股机制:成交额 TOP vs 涨停/跌停/TOP30/龙头 🟡
- **期望**:web_search 昨日涨停/跌停/成交量 TOP30/板块龙头来组 100 池。
- **现状**:用**确定性成交额排序筛选**(主板 only)替代了 websearch 选股,[`build-watchlist.ts`](../src/app/build-watchlist.ts) 显式标 `webSearchUsed:false`;涨停只在 themeHeat 算了个家数。
- **建议**:`视情况` —— 接真涨停/龙虎榜数据源成本高;现状成交额 TOP 是合理且抗幻觉的替代。倾向 `保现状+改文档`,除非你要原汁原味(则归入 PRE-07 一起接数据源)。
- **验收**:跑 08:30,池子来源符合你裁决的口径。
- **裁决**:☐ 待定

### PRE-05 08:30 写 `potential_stocks.json`(10 潜力股)🔴
- **期望**:精选 10 支潜力股写入 `potential_stocks.json`。
- **现状**:**完全没写**。10 潜力股(`shortlist10`)只进了 `DailyTradingPlan` 内部;`potential_stocks` 这个 category [有定义](../src/domain/market/watchlist.ts)但盘前流程零代码调用。
- **建议**:`改代码` —— 从 `shortlist10` 镜像落盘成 `potential_stocks.json`。低成本、硬缺口。
- **验收**:跑 08:30,`memory/market/watchlists/potential_stocks.json` 有 ≤10 条。
- **裁决**:☐ 待定

### PRE-06 09:15 强制 web_search(一字板情绪)🟠
- **期望**:**强制** web_search 一字板名单。
- **现状**:09:15(`call_auction_watch`)**不在 NEWS_HEAVY**,`forceWebSearch:false`;搜不搜取决于查询词是否命中正则,不稳定、非强制。
- **建议**:`改代码` —— 把 `call_auction_watch` 纳入强制搜。低成本。
- **验收**:跑 09:15,稳定产生 web_search 上下文。
- **裁决**:☐ 待定

### PRE-07 09:15 一字板名单 / 封单金额 / 封单王 / 主力意图 🔴
- **期望**:抓一字板名单 + 封单金额,统计最强题材和封单王,判断主力意图。
- **现状**:**全仓库无任何盘口/竞价/封单数据源**。只有 changePct≥9.9% 近似的涨停家数,封单维度为零;"封单王/主力意图"靠模型从新闻 snippet 猜。
- **建议**:`视情况` —— 这是最大工作量项,需接 L1/盘口或第三方竞价封单数据源,建议分阶段。先定要不要做、用哪个源。
- **验收**:跑 09:15,有真实一字板名单 + 封单金额排名。
- **裁决**:☐ 待定

---

## B. 盘中实时(哨兵 / 脉搏 / 降噪)

### MID-01 3 秒哨兵常驻进程 🟢
- **现状**:真常驻([`MarketSentinelRunner`](../src/infrastructure/scheduler/market-sentinel-runner.ts) setTimeout 自递归,默认 3s)、真拉腾讯、红线齐(2%急动/±5%/8%止损)、10 分钟冷却且持久化。需 `npm start`/`--live` 接真网络。
- **建议**:`保持`。
- **验收**:`--live` 跑,看 tick 与红线触发日志。
- **裁决**:☐ 保持(确认即可)

### MID-02 哨兵唤醒未走统一 wake 信封 🟡
- **现状**:哨兵直连 [`analyzeMarketAlert`](../src/app/sentinel-brain.ts),没走 `dispatchCerebellumWake`(只闹钟矩阵走)。功能达成,架构不统一。
- **建议**:`视情况` —— 纯一致性重构,可低优先级或不做。
- **裁决**:☐ 待定

### MID-03 10 分钟静默脉搏:不在矩阵 + 窗口不符 🟡
- **期望**:9:30–11:20 / 13:00–14:50 每 10 分钟。
- **现状**:[`buildSilentPatrolDaemonTask`](../scripts/dev/market-sentinel-daemon.ts) 能跑,但**不在闹钟矩阵**,窗口是 11:30/15:00 ≠ 需求 11:20/14:50。
- **建议**:`改代码` —— 至少对齐窗口;是否纳入矩阵看你。
- **验收**:盘中窗口边界与裁决一致。
- **裁决**:☐ 待定

### MID-04 脉搏异动从不唤醒大脑 🔴
- **期望**:脉搏发现异动生成"活跃唤醒 Prompt"踢醒大脑。
- **现状**:巡航任务无 brainProvider,异动只发确定性告警,**不踢大脑**。
- **建议**:`视情况` —— 接上则脉搏异动也能唤醒(成本=token);或承认哨兵已覆盖异动唤醒、脉搏只做静默巡航(改文档)。
- **裁决**:☐ 待定

### MID-05 silent-patrol 双实现冗余 🟡
- **现状**:域纯函数版 [`silent-patrol.ts`](../src/domain/cerebellum/silent-patrol.ts)(`second===0` 有漏槽隐患)与 daemon 版并存、行为不一致。
- **建议**:`改代码` —— 删一套、统一。
- **裁决**:☐ 待定

### MID-06 推送降噪 🟢
- **现状**:[`shouldPushToExternalChannels`](../src/domain/notification/push-policy.ts) 只放行 操作/系统红线/定时报告,雷达只本地 log,完全符合需求。
- **建议**:`保持`。
- **裁决**:☐ 保持(确认即可)

---

## C. 操作 → 数据库(手)—— 最扎实,但有真 bug

### HAND-01 买入链路真改库 🟢
- **现状**:[`paper-broker.ts` `persistFilledOrder`](../src/infrastructure/broker/paper-broker.ts) 真写 account/positions/trades/orders/audit;backups 实证现金 20000→2416。
- **建议**:`保持`。
- **裁决**:☐ 保持(确认即可)

### HAND-02 T+1 没有跨日 rollover 🔴(真 bug,优先修)
- **现象**:买入后 `availableQuantity` 永远 0、`todayBuyQuantity` 永不清零([`calculations.ts`](../src/domain/portfolio/calculations.ts) 无 rollover);backups 里 06-23 买的票到 06-24 仍锁死 → **纸面持仓事实上永远卖不出去**。
- **建议**:`改代码` —— 必修。加跨日结算:新交易日把 `todayBuyQuantity` 清零、`availableQuantity` 提升为可卖。
- **验收**:买入次日重演,该持仓 `availableQuantity` = 全量,SELL 能成交。
- **裁决**:☐ 待定(建议:改代码)

### HAND-03 卖出链路打通(依赖 HAND-02)🟠
- **现状**:SELL 校验/改库代码在,但因 HAND-02 基本卡在 `no_sellable_quantity`。
- **建议**:`改代码` —— 随 HAND-02 一起验证一笔完整卖出落库。
- **验收**:一笔 SELL 真改库(现金增、持仓减、trades 记录)。
- **裁决**:☐ 待定

### HAND-04 主板正则两处重复 🟡
- **现状**:[`symbols.ts`](../src/domain/market/symbols.ts) 与 [`policy-engine.ts`](../src/domain/risk/policy-engine.ts) 各一份主板判定,口径有细微差异(都拒科创/创业)。
- **建议**:`改代码` —— 合并到单一来源。
- **裁决**:☐ 待定

### HAND-05 proposal 与 execution 两步可能"只提案不成交" 🟡
- **现状**:无报价/现金不足/风控 reject 都会 skip。BUY 侧通,SELL 侧因 HAND-02 受限。
- **建议**:`保现状` —— 各种 skip 都有合理原因;确保报告把 skip 原因写清(已部分做)。
- **裁决**:☐ 待定

---

## D. 记忆 / 海马体

### MEM-01 盘后快照自动切片 🟢(时点 15:30 非 15:05)
- **现状**:[`archiveDailySnapshot`](../src/app/archive-daily-snapshot.ts) 纯代码,在 **15:30** `post_close_review` 触发,写 snapshots/ + daily-summary.jsonl。
- **建议**:`保现状+改文档`(把文档 15:05 更正为 15:30),或无所谓。
- **裁决**:☐ 待定

### MEM-02 反哺(盘前读教训)🟢
- **现状**:21:00 distill 写 `long_term/*.md` → 次日 08:15/08:30 [`loadKnowledgeForWake`](../src/app/load-knowledge-for-wake.ts) 读回注入,闭环对得上。
- **建议**:`保持`。
- **裁决**:☐ 保持(确认即可)

### MEM-03 20:30 投喂的是估值快照,非"当日成交账单" 🟡
- **现状**:[`buildAskContext`](../src/app/ask-portfolio.ts) 喂实时持仓估值,**没有当日 fills/盈亏明细账单**;且 20:30 默认走 deep_review。
- **建议**:`改代码` —— 加"当日成交账单"对象进 20:30 复盘 prompt。
- **裁决**:☐ 待定

### MEM-04 长期记忆"强制大脑调 write 工具" → 实为后端 distill 🟡
- **现状**:是 [`distill-daily-knowledge.ts`](../src/app/distill-daily-knowledge.ts) **代码替它写**,不是文档说的"强制大脑调工具";且依赖当天有 scored decisions,否则静默不写。
- **建议**:`保现状+改文档` —— 代码 distill 比"强制大脑写"更可靠;但补一条:无 scored decisions 时也要落一条降级记录。
- **裁决**:☐ 待定

### MEM-05 `memory_write` / `search_memory` 工具实时 agent 循环没挂 🔴
- **现状**:工具只在 webhook handler 接了;daemon 用的 [`buildPaperAgentTools`](../src/app/brain-agent-tools.ts) 只有交易/行情类,没有记忆读写工具。
- **建议**:`视情况` —— 看你要不要让对话/节点里的大脑能查/写记忆。
- **裁决**:☐ 待定

### MEM-06 语义/向量检索 🔴(ADR 故意不做)
- **现状**:只有纯关键词子串匹配([`memory-registry.ts`](../src/infrastructure/storage/memory-registry.ts));[ADR](../docs/architecture/decision-records/2026-06-16-vector-semantic-memory-search-evaluation.md) 确认一阶段不做向量。文档 L290 宣称的"向量语义搜索"是空头支票。
- **建议**:`保现状+改文档`(或排到 future)。
- **裁决**:☐ 待定

### MEM-07 关键词+结构化检索引擎"没插电" 🟠
- **现状**:`MemoryRegistry` 能力齐全有单测,但运行态无真实例调用(唯一入口 `runWatchMarketOnce` 无调用方、默认 mock)。
- **建议**:`改代码` —— 把它接到对话/查询路径,让"按时间区间/关键词查账本与记忆"真能用。
- **裁决**:☐ 待定

---

## 进度看板(2026-06-24 夜间施工后)

| 条目 | 施工前 | 夜间动作 | 现状 |
|---|---|---|---|
| INFRA-01 重演换血 | 🟡 | 改代码 | ✅ paper_ops 重演空池时当日换血补池(非as-of,已注明) |
| INFRA-02 不覆写空池 | 🔴 | 改代码 | ✅ skipWriteWhenEmpty,空筛选不再覆写好池 |
| PRE-01 08:00 体检 | 🟡 | 改代码 | ✅ runDataWarmupSelfCheck 确定性本地自检 + 单测 |
| PRE-02 08:15 漏A50 | 🟡 | 改代码 | ✅ 查询词补 富时中国A50 |
| PRE-03 逐条持仓影响 | 🟡 | 改代码 | ✅ 08:15/08:30 注入逐持仓利好/利空清单 + 单测 |
| PRE-04 涨停/跌停信号 | 🟡 | 改代码 | ✅ classifyLimitState 注入每条池子 metadata+reason + 单测 |
| PRE-05 potential_stocks.json | 🔴 | 改代码 | ✅ 漏斗 shortlist10 镜像落盘 + 真跑验证 |
| PRE-06 09:15 强制搜 | 🟠 | 改代码 | ✅ call_auction_watch 纳入 NEWS_HEAVY |
| PRE-07 一字板/封单 | 🔴 | Boss 拍板:不做 | ⛔ 涨停/topGainers 已由 theme-heat 提供;封单金额/封单王 **Boss 决定不接**(无现成数据源,未编造) |
| MID-01 3秒哨兵 | 🟢 | 确认 | 🟢 保持 |
| MID-02 wake信封统一 | 🟡 | 不改 | 🟡 功能达成,架构统一留作可选重构 |
| MID-03 巡航窗口 | 🟡 | 保现状+改文档 | 🟡 **保留全交易时段(9:30-11:30/13:00-15:00),优于 spec 的 11:20/14:50**(收盘段由3秒哨兵覆盖) |
| MID-04 巡航唤醒大脑 | 🔴 | 改代码 | ✅ 巡航异动(慢漂移)预算内唤醒大脑研判 |
| MID-05 双实现去重 | 🟡 | 保现状 | 🟡 纯域helper与活体daemon驱动是两层,非真重复;不删已测公共API |
| MID-06 推送降噪 | 🟢 | 确认 | 🟢 保持 |
| HAND-01 买入改库 | 🟢 | 确认 | 🟢 保持 |
| HAND-02 T+1跨日结算 | 🔴 | 改代码 | ✅ **真bug已修**:rollForward + broker自动结算 + 每日settle + 真跑验证(隔日可卖) |
| HAND-03 卖出链路 | 🟠 | 改代码 | ✅ 随 HAND-02 打通,跨日卖出成交 + 测试 |
| HAND-04 主板正则去重 | 🟡 | 改代码 | ✅ policy-engine 委托 inferAshareBoard 单一来源 |
| HAND-05 提案/成交两步 | 🟡 | 保现状 | 🟡 各 skip 有原因,报告已写清 |
| MEM-01 盘后快照切片 | 🟢 | 改文档 | 🟢 实现正确;触发点是 **15:30**(spec 写 15:05,以代码为准) |
| MEM-02 反哺 | 🟢 | 确认 | 🟢 保持 |
| MEM-03 当日成交账单 | 🟡 | 改代码 | ✅ buildDailyFillsLedger 注入晚间复盘(15:00/15:30/自省/21:00)+ 测试;20:30 deep_review 路径为后续 |
| MEM-04 长期记忆写入 | 🟡 | 改文档 | 🟡 现状=后端 distill 代码落库(比"强制大脑写工具"更可靠),以现状为准 |
| MEM-05 记忆读写工具进agent | 🔴 | 改代码(Boss 让我设计护栏) | ✅ search_memory + remember 工具入 agent;护栏:固定追加路径、不碰规则/账本/密钥、schema+脱敏+限长、每轮限流5、每写审计 + 测试 + 真跑验证 |
| MEM-06 语义/向量检索 | 🔴 | 改文档 | 🔴 ADR 故意不做,保持关键词;文档 L290 宣称作废 |
| MEM-07 检索引擎接线 | 🟠 | 改代码(两个消费者都接) | ✅ 对话路径=agent 的 search_memory 工具;盘前反哺=loadKnowledgeForWake 按持仓/题材相关性检索(分词、时间栅栏)。引擎已通电 |

**计(2026-06-25 更新)**:✅ 16 条落地并测试(新增 MEM-05/MEM-07)· 🟢 5 条保持/确认 · 🟡 5 条保现状+改文档(已注明取舍)· 🔴 1 条(MEM-06 向量,ADR 故意不做)· ⛔ 1 条(PRE-07 封单,Boss 拍板不做)。

> 全程 740 测试绿、tsc 干净;每批一个提交在分支 `align/requirements-overnight`。
> "改文档"项以本合同为准,未改写 docs/requirements 那份历史对话记录。
