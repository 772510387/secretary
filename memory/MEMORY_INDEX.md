# 记忆库导航 (MEMORY_INDEX)

本目录是 A 股纸面交易助手的"长期记忆"。各子目录职责如下：

- `rules/` — 宪法/规则：硬约束与交易纪律，最高优先级，人工复核后落地。
- `long_term/` — 长期经验沉淀：跨周期提炼的经验与教训。
- `daily_logs/` — 每日落库快照：盘后 15:30 归档的当日账户快照/摘要。
- `reviews/` — 周/月/年复盘：阶段性总结与反思。
- `history/` — 个股历史：逐标的的历史记录与轨迹。
- `portfolio/` — 账户/持仓/快照：account.json、positions.json 及 `snapshots/` 每日全量快照、daily-summary.jsonl 每日一行摘要。
- `plans/` — 每日选股计划：按交易日组织的 100→10→待买卖漏斗计划。
- `proposals/` — 待复核提案：模型给出、等待人工确认的买卖建议。
- `market/watchlists/` — 100 池：每日维护的高关注股票池。
- `market/cache/` — 行情缓存：可再生的临时缓存（会被清洗）。
- `reports/` — 报告：生成的分析/汇报文档。
- `research/` — 调研：联网检索与深度研究产出。
- `logs/` — 审计与运行日志：audit-*.jsonl 等不可变记录。
- `alert_state.json` — 哨兵冷却态：盯盘哨兵的去重/冷却状态。

说明：`rules/`、`long_term/`、`portfolio/`、`proposals/`、`reviews/`、`history/` 与审计日志为持久资产，清洗任务绝不删除；仅 `plans/<日期>/` 与 `market/cache/` 中超期的临时产物会被裁剪。
