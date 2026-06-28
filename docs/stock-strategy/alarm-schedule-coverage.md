# 每日闹铃清单 vs 小脑闹铃矩阵：覆盖度对账

> 更新时间：2026-06-28

## 结论

`docs/display/daily-alarm-list.md` 的盘中核心链路已对齐到当前代码：

- 固定必报点已由代码闹钟控制：`09:15`、`09:25`、`10:30`、`11:30`、`13:30`、`14:30`、`15:00`。
- 链式静默巡航已改为清单里的显式槽位：`09:30/09:35/09:40/09:45/10:00/10:10/10:20/10:40/10:50/11:00/11:10/11:20` 与 `13:00/13:10/13:20/13:40/13:50/14:00/14:10/14:20/14:40/14:50`。
- `npm start` 会同时启动飞书对话、3 秒哨兵、固定闹钟矩阵和链式静默巡航。
- 哨兵红线已覆盖 1 分钟急涨急跌 2%、绝对涨跌 ±5%、突破前高、持仓 8% 硬止损、自选股异动和指数 ±1% / 系统性风险。
- 飞书外推已升级：市场哨兵和指数雷达的 `warning/critical` 红线会主动推送；普通巡航静默脉冲、接近观察价、量价普通观察仍只进本地日志。

## 已实现映射

| 清单能力 | 当前状态 | 代码位置 | 说明 |
|---|---|---|---|
| 8:00 系统体检 | 部分实现 | `src/domain/cerebellum/alarm-matrix.ts`、`src/app/data-warmup-check.ts` | 有自检和固定节点；Cron/daemon 自身深度体检仍可增强 |
| 8:15 隔夜消息 | 已实现 | `alarm-matrix.ts`、`search-query.ts`、`alarm-brain.ts` | 清单未单列但需求中存在，保留 |
| 8:30 每日晨报 | 已实现 | `alarm-matrix.ts`、`alarm-brain.ts` | `pre_market_plan` |
| 9:15 每日启动/补池 | 已实现 | `cerebellum-daemon.ts`、`build-context.ts` | 固定节点触发全市场探查和 100 池换血 |
| 9:25 开盘确认 | 已实现 | `alarm-matrix.ts` | `pre_open_confirmation` |
| 10:30 上午走势必报 | 已实现 | `alarm-matrix.ts` | `morning_review` 已从 10:00 调整为 10:30 |
| 11:30 上午收盘总结 | 已实现 | `alarm-matrix.ts` | `midday_review` |
| 13:30 午后跳水必报 | 已实现 | `alarm-matrix.ts` | `afternoon_risk_scan` 已从 14:00 调整为 13:30 |
| 14:30 尾盘/炸板 | 已实现 | `alarm-matrix.ts` | `late_session_plan` |
| 15:00 收盘最终总结 | 已实现 | `alarm-matrix.ts` | `closing_snapshot` |
| 15:30 盘后扩展复盘 | 已实现 | `alarm-matrix.ts` | 需求源中有该节点，清单展示未单列 |
| 20:30 盘后总结/深度复盘 | 已实现 | `cerebellum-daemon.ts` | 配置 TradingAgents-CN 时走深度研究 |
| 21:00 晚间内省 | 部分实现 | `distill-daily-knowledge.ts` | 经验沉淀和规则提案已实现；算力统计/胜率/盈亏比/最大回撤仍未完整 |
| 链式静默巡航 | 已实现 | `silent-patrol.ts`、`market-sentinel-daemon.ts` | 平稳只打本地 `[PULSE]`，异常才唤醒/推送 |
| 飞书主动报警 | 已实现 | `push-policy.ts`、`push-notifiers.ts` | `FEISHU_NOTIFY=1` 后推送红线、固定报告、已执行模拟盘操作 |

## 仍未完成

| 优先级 | 缺口 | 触碰范围 |
|---|---|---|
| P1 | 月度/年度清单要“月初 1 号 9:00 展望、1 月 1 号 10:00 年度战略展望”，当前是月末/年末复盘（语义改动，暂缓） | `alarm-matrix.ts`、`alarm-sop.ts` |
| P1 | 21:00 内省缺算力/token 统计、胜率、盈亏比、最大回撤 | `daily-budget.ts`、绩效计算、`distill-daily-knowledge.ts` |
| P2 | 静默巡航的事件链信封还没有完整落库 `activationReason/nextCheckpoint` | `wake-event.ts`、`market-sentinel-daemon.ts` |

> 2026-06-28 更新：周末 7 个任务已补齐——周六 `08:30 周末晨报`/`10:00 周度深度复盘`/`14:00 知识吸收`/`15:30 实盘周报`/`16:00 胜率复盘`，周日 `08:30 周末晨报`/`14:00 知识吸收`。新增 alarm 类型 `weekend_morning_brief`、`weekly_knowledge_absorb`、`weekly_live_report`、`weekly_winrate_review`（见 `alarm-matrix.ts`、`alarm-sop.ts`、`display-contract.ts`）。

## 当前运行方式

```powershell
npm start
```

默认组合：飞书双向对话 + 3 秒哨兵 + 固定闹钟矩阵 + 链式静默巡航。真实外推需要 `.env` 配置 `FEISHU_NOTIFY=1`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET` 和推送用户。
