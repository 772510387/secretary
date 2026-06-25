# 选股漏斗（每日维护 + 待买卖 + 受控执行）

把全市场数据收敛成一条每日维护的漏斗，并在严格 paper 边界内执行：

```
全市场数据 ──筛选──> 100 高关注池 ──模型选──> 10 潜力股 ──模型定──> 待买/待卖（提案）──确认/auto──> 模拟盘持仓
```

## 运行（每个闹钟点跑一次）

```bash
# 默认：只产出提案 + 推飞书，不自动成交（待人工确认）
npm run funnel:dev -- --alarm pre_market_plan

# 模拟盘自动成交（仅 paper，永不实盘）；不加这个开关就只提案
npm run funnel:dev -- --alarm closing_snapshot --auto-paper

# 只跑选股、不执行（看看候选）
npm run funnel:dev -- --alarm midday_review --auto-paper --dry-run
```

产物：
- `memory/watchlists/watchlist_today.json` —— 刷新后的 100 高关注池。
- `memory/plans/<日期>/<planId>-seq<N>.json` —— 当日计划（逐节点一份快照：100 池拷贝 + 10 潜力 + 待买卖引用）。
- `memory/proposals/…` —— 待买/待卖的复核提案（`executable:false`，待人工复核）。
- 飞书推送：每个节点的候选 + 待买卖摘要。

## 安全红线（代码强制，非约定）

- **模型只提案，从不执行**：模型输出仅是结构化候选（`executable:false`、`status:pending_review`），数量与价格由后端按风控确定，模型无下单/写账户/改规则权限。
- **执行只在严格 paper 仿真内**：`executePendingOrder` 的 `assertPaperOnly` 断言 `liveTrading=false && trading.mode=paper && broker.provider=paper && account.type=paper`，否则抛错、绝不降级。`--auto-paper` 只是仿真便利，**永远到不了真实券商/真钱**；实盘永不自动。
- **走真实风控**：买卖经 RiskEngine（单股上限/止损/单日亏损）+ PaperBroker（主板/100 股/现金/T+1），与 `npm run trade` 同一条经过验证的路径。
- **幂等**：intentId 由 proposalId 派生，重复确认不会重复成交。
- **选股不越界**：模型挑的票必须在当日 100 池内（买）或已持仓（卖），后端取交集，杜绝凭空代码。
- **无未来函数**：100 池是当下全市场筛选；历史某天的池无法事后重建（只向前每天跑+落快照）。

## 已接进常驻 daemon（2026-06-23）

漏斗已自动挂进常驻 `npm start`（经 `cerebellum-daemon` 的 `createAlarmRunNode`）：
- **换血**：08:30 / 09:15 用确定性筛选（主板-only、成交额 top）重建 100 池，并算市场题材热度（涨停家数/热度评分）。
- **眼**：每节点读 100 池 + 给「池∪持仓」取价 + 按节点产真实中文检索词 + 显式 `dataHealth`（缺数据如实降级，不让大脑幻觉）。
- **待买卖**：交易节点（盘前/竞价/早盘/午盘/午后/尾盘/收盘）跑 `maintainDailyFunnel`，**模拟盘自动成交常开**（`executePendingOrder` 硬 paper 闸；实盘永不自动），做完推飞书汇报。
- **8% 硬止损**：3 秒哨兵触发 `executePaperStopLoss` 在模拟盘里强制平仓（确定性、不问大脑）。
- **反哺**：21:00 `distillDailyKnowledge` 把当日教训写 `memory/long_term/` + 复核规则提案；08:15/08:30 `loadKnowledgeForWake` 把过往教训注入唤醒 prompt。

手动单节点仍可用 `npm run funnel:dev -- --alarm <节点> [--auto-paper] [--dry-run]`。

真实全跑（自验）：`NODE_USE_ENV_PROXY=1 npm run cerebellum:dev -- --fire-all`（需真 dashscope；会推飞书 + 模拟盘自动成交）。
