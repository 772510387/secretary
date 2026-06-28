# 隔夜实现总结（2026-06-28 夜 → 06-29）

> 目标：按 `docs/display/*` 样张把飞书交互"实现到位"。分支 `feat/feishu-display-and-data`，
> 基线绿（typecheck 0 错、846 测试通过）→ 收尾绿（typecheck 0 错、**858 测试通过**，0 失败）。
> 未推送、未触真实交易、未改主分支历史。`2e24d7c` 把动手前的工作区 WIP 先存了一个 checkpoint，
> 我的改动是其之上的干净 diff。

## 已完成（已提交，逐块）

| 提交 | 内容 | 价值 |
|---|---|---|
| `0a0288d` **F1 展示契约层** | 新增 `src/app/display-contract.ts`：共享人格/格式/诚实标记契约 + 逐节点骨架（盘前市场背景、竞价`一字板/题材/封单`三列表、盘中`观察→判断→策略→下次复查`、盘后/周期复盘）。接入 `alarm-brain`(推送)、`agent-planner`(手动SOP)、`run-brain-agent`(反应式问答系统提示)。 | **核心诉求**：所有飞书输出现在按样张骨架组织，主动推送和手动问答同契约。 |
| `25d231d` **F2a 决策评分落库** | 新增 `npm run score:decisions`（`scripts/dev/score-decisions.ts`）+ 纯函数 `resolveTrailingDecisionWindow`(已测)。复用现有引擎做"近若干已结算交易日"的重放→评分→落 `memory/decisions/`。 | 补上 `get_strategy_knowledge` 的**唯一数据来源**（此前只有离线回测会写）。只读、确定性、不下单。 |
| `1e3adca` **周末闹钟补全** | 新增 4 个 alarm 类型 + 6 条周末规则（周六 08:30/10:00/14:00/15:30/16:00，周日 08:30/14:00），各带只读 SOP，映射周期复盘骨架。矩阵测试更新为 23 节点。 | 关闭 coverage 审计的 **P0** 缺口（周末 7 任务）。纯增量，不动现有行为。 |
| `ef94cf9` **F2b 可观测降级** | `readPotentialStockCandidates` 读失败不再静默返回 `[]`，打印告警。 | 修复"空池 vs 读失败无法区分"。（每日刷新本就由 funnel 节点的 `writePotentialStocksPool` 自动跑，陈旧只是 daemon 未运行。） |
| `e0159d5` **文档** | `docs/ops/feishu-bot.md` 增补：展示契约、证据工具、周末矩阵、`score:decisions`。 | 运维可见。未改你的 `docs/display/*` 样张（属你的设计稿）。 |

## 关键发现

- **策略库目前没有数据**，因为 `memory/decisions/` 从不在日常环路里写——写入器 `DecisionMemoryStore` 此前只被离线 `replay-backtest.ts` 调用。已用 `score:decisions` 补上机制。
- 跑 `score:decisions` 时发现**当前模拟盘是空仓**（无持仓），所以暂时没有可评分的持仓判断；**等账户在某窗口内持有过仓位、再跑该命令，`memory/decisions/` 才会有数据**，策略库随之有内容。这是数据现实，不是 bug。

## 有意延后（附理由，未做）

| 项 | 为什么延后 |
|---|---|
| **F2d 跨日成本台账**（已实现盈亏） | 触碰 portfolio 计算核心，无人值守下风险高；同日买卖的盈亏已能算，跨日缺成本时如实标"未确认"（已有降级），不是错算。建议白天有人盯着时做。 |
| **21:00 内省统计**（token/胜率/最大回撤） | 依赖已评分决策（当前为空）+ 改 daemon 晚间热路径。现在做大多会显示"未统计"，价值低、风险高。等 `score:decisions` 有数据后再接。 |
| **月度/年度改月初/年初时点** | 语义改动（月末复盘→月初展望），且耦合现有矩阵测试；非工作日不影响周一。 |
| **config 外置**（`FEEDBACK_AUDIT_*` 等） | 默认值可用，外置要改 config schema 多处，ROI 低。 |
| **chunking helper 抽离** | 分片(1/N)+脱敏现已工作且有测试覆盖，抽离只是整洁度。 |

## 怎么验收（明天）

```powershell
git checkout feat/feishu-display-and-data
npm run typecheck && npm test          # 应 0 错、858 通过
npm run cerebellum:dev -- --fire morning_review   # 看推送是否按 观察→判断→策略→下次复查→Boss摘要
npm run cerebellum:dev -- --fire call_auction_watch  # 看是否给 一字板/题材/封单 三列表
npm run score:decisions                # 账户有持仓窗口时会写 memory/decisions/
```

飞书私聊可问"今天复盘 / 上周为什么只操作两支 / 策略库怎么样 / 潜力股池深度分析"验证证据工具 + 呈现深度。

## 合并建议

分支自成体系、全程绿。可直接 review `git diff main...feat/feishu-display-and-data`（跳过首个 WIP checkpoint 提交看我的 5 个功能提交）。确认后我可以帮你合并或继续做延后项。
