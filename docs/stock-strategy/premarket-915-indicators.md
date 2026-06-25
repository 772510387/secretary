# 9:15 盘前流程 + 三指标（封单 / 竞价一字板 / 题材）能力审计

> 落盘时间：2026-06-25　会话标识：premarket-915-indicators

## 1. 本会话探查范围
审计 9:15 集合竞价节点当前实际做了什么，并逐项核对 Boss 的 9:15 清单（大盘广度 / 板块热度 / 观察股筛选）+ 追加的三个指标（竞价一字板、走的题材、封单）是否已实现；对缺失项构想 眼/小脑/大脑 + harness 工具的实现路径。

## 2. 关键发现（带证据）
- 9:15 节点 = `call_auction_watch` 闹钟，北京时间 09:15，brainTaskType=pre_market_plan。见 [alarm-matrix.ts:45](../../src/domain/cerebellum/alarm-matrix.ts#L45)。9:25 是 `pre_open_confirmation`，见 [alarm-matrix.ts:53](../../src/domain/cerebellum/alarm-matrix.ts#L53)。
- SOP 只是「只读上下文契约」，本身不抓数、且明令禁止编造竞价价格/量。见 [alarm-sop.ts:146](../../src/domain/cerebellum/alarm-sop.ts#L146) 的 call_auction_watch 模板。
- 9:15 配的 web 搜索词字面含「一字板」，但结果是自由文本喂大脑，无结构化抽取。见 [search-query.ts:28](../../src/domain/cerebellum/search-query.ts#L28)。
- 大盘广度（涨跌家数 / 涨停跌停家数 / topGainers / topByAmount / heatScore）已用纯函数实现。见 [theme-heat.ts](../../src/domain/market/theme-heat.ts) `computeThemeHeat`。涨停跌停按 `changePct≥9.8%`（主板）阈值代理，见 `limitThresholdForBoard` [theme-heat.ts:66](../../src/domain/market/theme-heat.ts#L66) 与 `classifyLimitState` [theme-heat.ts:90](../../src/domain/market/theme-heat.ts#L90)。
- **代码已明确写明三指标里两个是故意没做的**：[theme-heat.ts:90](../../src/domain/market/theme-heat.ts#L90) 注释——"NOT a true 一字板 (needs open=high=low order-book data we don't have) and NOT 封单 (no order-book source at all)"。
- 成交量前50 / 涨跌幅前50 已实现：`screenUniverse` [screener.ts:90](../../src/domain/market/screener.ts#L90) + `categorizeUniverse` 的 amount_top/change_top 桶，落库于 `persistCategorizedPool` [build-watchlist.ts:191](../../src/app/build-watchlist.ts#L191)。
- **封单数据其实已在腾讯响应里被白白丢掉**：`qt.gtimg.cn` 单行含买一~买五价/量（约 parts[9]–[19]），但 parser 只取到 parts[37] 的若干字段，整段盘口未解析。见 [tencent-quote-provider.ts:144](../../src/infrastructure/providers/tencent-quote-provider.ts#L144)（已解析 open=parts[5]/high=parts[33]/low=parts[34]/latest=parts[3]/prevClose=parts[4]，但无盘口量）。
- universe 数据源无 OHL、无盘口、无行业/概念字段：eastmoney FIELDS 只有 f12,f13,f14,f2,f3,f5,f6,f8,f20。见 [eastmoney-universe-provider.ts:61](../../src/infrastructure/providers/eastmoney-universe-provider.ts#L61)。
- agentic 工具循环缺「市场情报类只读工具」：现有工具仅 get_portfolio/get_quote/get_technicals/paper_buy/paper_sell/search_memory/remember/run_paper_ops，无 market-breadth / sector-heat / auction-board 工具。见 [brain-agent-tools.ts:261](../../src/app/brain-agent-tools.ts#L261) 起。

## 3. 现状判定（逐能力点）
| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 涨跌家数分布 | ✅ | theme-heat.ts computeThemeHeat | advancers/decliners |
| 涨停/跌停家数 | 🟡 阈值代理 | theme-heat.ts:90 / :160 | changePct≥9.8%，非真封板 |
| 成交量变化 | 🟡 | 个股 f5/f6 有；无全市场量能 vs 昨日聚合 | 未充分验证 |
| 板块领涨/领跌 | ❌ | eastmoney-universe-provider.ts:61 无行业字段 | theme-heat 是全市场一个分 |
| 资金流向 | 🟡 代理 | theme-heat topByAmount + turnoverConcentration | 无主力净流入/北向真数据 |
| 昨日涨停今日表现 | 🟡 | build-watchlist.ts:163 yesterday_limit_up 桶 | 需上游持久化昨日涨停名单 |
| 成交量前50/涨跌幅前50 | ✅ | screener.ts:90 + categorizeUniverse | amount_top/change_top |
| 热门板块龙头 | ❌ | 依赖板块数据 | 同板块缺失 |
| 竞价一字板 | ❌（数据可得） | theme-heat.ts:90；tencent-quote-provider.ts:144 已解析 OHL | 缺涨停价计算 + 未接 |
| 走的题材 | ❌ | 全栈无 concept 字段 | search-query 提到但无结构化落库 |
| 封单 | ❌（数据已在响应里） | tencent-quote-provider.ts:144 盘口未解析 | 买一量被丢弃 |

## 4. 待办 / 改造建议（按优先级）
| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 封单：扩展 quote 解析买一价/量 + 涨停价计算器 + 9:25 封单榜 | tencent-quote-provider.ts、domain/market/schemas.ts(QuoteSnapshot)、新建涨停价 util | 无（数据已在手） |
| P0 | 竞价一字板：复用涨停价 + 9:25 批量 quote（开=高=低=最新=涨停价） | 同上 + 9:25 节点接线 | 依赖涨停价 util |
| P1 | 板块 provider：补「板块领涨/领跌 + 龙头」 | 新建 eastmoney-sector-provider.ts、providers/index.ts | 无 |
| P1 | 题材归因：web_search_market + tag_theme 写工具 + 出处校验 | brain-agent-tools.ts、search-query.ts、watchlist DB | 板块 provider 更佳 |
| P1 | 市场情报只读工具：get_market_breadth / get_sector_heat / get_auction_board | brain-agent-tools.ts、domain/market/index.ts | 依赖上面数据层 |

## 5. 开放问题 / 信息缺口
- 「昨日涨停名单」由谁持久化、写到哪？yesterdayLimitUpSymbols 的上游未追到，需另查。
- 时点归属：真·一字板/封单只有 9:25 撮合冻结后才确定；该把 auction-board 计算挂在 9:15(call_auction_watch) 还是 9:25(pre_open_confirmation)？倾向 9:25，待确认。
- 「成交量变化」是否有全市场量能 vs 昨日的聚合逻辑？本会话未查证，暂判 🟡。
- 资金流向是否有除成交额代理外的真数据源（主力净流入/北向）？未发现，待确认。
- 工具注册层（brain-agent-tools.ts、domain/market/index.ts、providers/index.ts barrel）是多任务共改的冲突点，需在分工时串行收口。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）
- src/infrastructure/providers/tencent-quote-provider.ts　← 封单/一字板核心，P0
- src/domain/market/schemas.ts（QuoteSnapshot）　← 封单字段，P0
- src/domain/market/theme-heat.ts　← 广度/涨停跌停（已实现，注释解释了缺口）
- src/domain/market/screener.ts、src/app/build-watchlist.ts　← 池筛选/分类（已实现）
- src/infrastructure/providers/eastmoney-universe-provider.ts　← universe 字段（板块缺失根因）
- src/app/brain-agent-tools.ts　← **共改冲突点**：题材/广度/板块工具都要往这加
- src/domain/market/index.ts、src/infrastructure/providers/index.ts　← **共改冲突点**：barrel 导出
- src/domain/cerebellum/alarm-matrix.ts / alarm-sop.ts / search-query.ts　← 9:15/9:25 节点接线
- （新建）涨停价计算 util、eastmoney-sector-provider.ts
