# docs/stock-strategy — 多会话探查落盘区

各个 Claude Code 会话之间**不共享上下文**，唯一的传话筒是硬盘。本目录是所有探查会话把结论**落盘**的地方，落盘后由一个协调会话统一汇总。

## 约定

1. **一个会话 → 一个文件**。文件名用 kebab-case 反映该会话的主题，例如 `sealing-order.md`、`sector-heat.md`、`auction-board.md`。
2. **写前先 `ls docs/stock-strategy/`**，避免和已有文件重名；重名就在后面加 `-2`。
3. **统一用 [_TEMPLATE.md](_TEMPLATE.md) 的结构**，这样事后能机械合并。
4. **只写查证过的东西**；没验证的放进模板第 5 节「信息缺口」，不要编。
5. 写完在下面的索引表加一行。

## 索引（每个会话写完补一行）

| 文件 | 主题 | 落盘日期 | 状态 |
|---|---|---|---|
| [premarket-915-indicators.md](premarket-915-indicators.md) | 9:15 盘前 + 封单/一字板/题材/板块 能力审计 | 2026-06-25 | 已落盘 |
| [board-judgment-chain.md](board-judgment-chain.md) | 盘面判断链（观察→判断→复查闹钟）现状审计+落地方案 | 2026-06-25 | 已落盘，板块源定走东财概念板块 |
| [alarm-schedule-coverage.md](alarm-schedule-coverage.md) | 每日闹铃清单 vs 小脑闹铃矩阵覆盖度对账 | 2026-06-25 | 已落盘 |
| [review-grounding.md](review-grounding.md) | 复盘行为：缺确定性事实层+防幻觉叙述契约（数字/时区/理由全靠模型编） | 2026-06-25 | 已落盘 |
| [strategy-knowledge-base.md](strategy-knowledge-base.md) | 成长式策略知识库（strategies/cases/decision_log + 五步增长闭环）是否落地 | 2026-06-25 | 已落盘；✅ 选定方案 B（桥接），待验 T+1（HAND-02/03） |
| [pre-market-brief.md](pre-market-brief.md) | 盘前"早盘观点/有啥大事"(9:15前)数据覆盖审计（与 premarket-915-indicators 主题相邻，证据互补） | 2026-06-25 | 已落盘 |
| [trading-day-simulation.md](trading-day-simulation.md) | 交易日模拟（节点逐格复盘）：openclaw 样本=叙述式幻觉，secretary 接地等价物现状(~80%)+落地方案 | 2026-06-25 | 已落盘；老板选定方案 A（接分时源） |
| [intraday-minute-data-source.md](intraday-minute-data-source.md) | 分时（分钟级）数据源可行性：方案 A 接线点+硬限制（免费腾讯端点只给当天，历史日要录制器；竞价段9:15-9:25无源） | 2026-06-25 | 已落盘；范围被 market-data-source-matrix 收缩（历史不要分钟） |
| [market-data-source-matrix.md](market-data-source-matrix.md) | 行情数据源矩阵（粒度×时间跨度，含付费口径）：当日分时免费、历史只要时/日/周/月；周月K同腾讯端点白捡、60min免费(BaoStock)或付费(Tushare 2000元/年 HTTP) | 2026-06-25 | ✅已定：60min走免费BaoStock；日/周/月K免费腾讯 |
