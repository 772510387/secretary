# 每日闹铃清单 vs 小脑闹铃矩阵：覆盖度对账

> 落盘时间：2026-06-25　会话标识：alarm-schedule-coverage

## 1. 本会话探查范围

对照 Boss 给的「每日闹铃清单」（工作日 32 + 周末 7 个闹铃，含链式激活/必报点设计），核对 `src/domain/cerebellum` 的闹铃矩阵实际实现了哪些时间节点、哪些时间点漂移、哪些缺失。目标是给后续改造一张「清单行 → 代码节点」的对账表。参考架构来源：[docs/requirements](../requirements)（眼/手/小脑/大脑解耦推演）与 d:/Project/main/openclaw 的 harness 模式。

## 2. 关键发现（必须带证据）

- 闹铃矩阵是**确定性硬编码表**，共 17 条固定规则，定义在 [alarm-matrix.ts:18-167](../../src/domain/cerebellum/alarm-matrix.ts#L18-L167) 的 `FIXED_CEREBELLUM_ALARM_RULES`。每条带 `beijingTime` / `frequency` / `brainTaskType`。
- 固定节点的实际时间点是：08:00 / 08:15 / 08:30 / 09:15 / 09:25 / **10:00** / 11:30 / **14:00** / 14:30 / 15:00 / 15:30 / 20:30 / 21:00（工作日）+ 00:00（每日）+ 周六10:00 + 月末20:00 + 12月31日20:00。逐条见 [alarm-matrix.ts:19-166](../../src/domain/cerebellum/alarm-matrix.ts#L19-L166)。
- **清单要的 10:30 必报，代码是 10:00**（`morning-review`，[alarm-matrix.ts:59-66](../../src/domain/cerebellum/alarm-matrix.ts#L59-L66)）；**清单要的 13:30 必报，代码里没有 13:30，最近的是 14:00**（`afternoon-risk-scan`，[alarm-matrix.ts:75-82](../../src/domain/cerebellum/alarm-matrix.ts#L75-L82)）。
- 固定闹铃的触发是**每分钟轮询**：`AlarmJobRegistry.runDue()` 比对当前北京时间分钟是否等于 `job.beijingTime`，命中且未跑过该 slot 才执行（[alarm-job-registry.ts:67-107](../../src/infrastructure/scheduler/alarm-job-registry.ts#L67-L107)，slot 去重见 :85-87，`weekdaysOnly` 过滤见 :77）。
- 链式静默巡航是**独立的 10 分钟栅格**，不是清单里逐分钟列的点。间隔默认 10 分钟（[silent-patrol.ts:19](../../src/domain/cerebellum/silent-patrol.ts#L19)），仅在 09:30–11:30 与 13:00–15:00 两个时段内（[silent-patrol.ts:27-30](../../src/domain/cerebellum/silent-patrol.ts#L27-L30)），且只在「秒=0 且 分钟%间隔==0」时触发（[silent-patrol.ts:240](../../src/domain/cerebellum/silent-patrol.ts#L240)）。
- 链式「默认静默、破线才汇报」已实现：silent-patrol 调 `checkMarketSentinel`，`wakeBrain = events.length > 0`，无事件则 `status:"silent"` 不唤醒大脑（[silent-patrol.ts:148](../../src/domain/cerebellum/silent-patrol.ts#L148)、[:166](../../src/domain/cerebellum/silent-patrol.ts#L166)）。
- 清单的激活红线**三条都有对应**：持仓绝对涨跌 ±5%（`absoluteMoveThreshold`，daemon 注入 0.05，[market-sentinel.ts:357-359](../../src/domain/cerebellum/market-sentinel.ts#L357-L359)）、急涨急跌 2%/分钟（`rapidMoveThreshold` 0.02，[:355](../../src/domain/cerebellum/market-sentinel.ts#L355)）、**大盘剧烈波动 ±1%**（`rapidDropThreshold/rapidSurgeThreshold` 0.01，[index-risk-radar.ts:284-285](../../src/domain/cerebellum/index-risk-radar.ts#L284-L285)）。另含持仓止损 8%（[:360](../../src/domain/cerebellum/market-sentinel.ts#L360)）、自选股日内 ±3%（[:361](../../src/domain/cerebellum/market-sentinel.ts#L361)）、防刷屏冷却 600 秒（[:364](../../src/domain/cerebellum/market-sentinel.ts#L364)）。
- 每个固定节点醒来后跑的是 SOP+大脑：`runAlarmNodeAnalysis` 先按 `alarmType` 取 SOP（[alarm-brain.ts:109-113](../../src/app/alarm-brain.ts#L109-L113)），SOP 分发器 `buildCerebellumAlarmSopByType` 在 [alarm-sop.ts:323](../../src/domain/cerebellum/alarm-sop.ts#L323)。
- 周/月/年复盘有专门落盘函数 `persistPeriodReview`，按类型写到 weekly_reviews / monthly_reviews / yearly_reviews（[persist-period-review.ts:26](../../src/app/persist-period-review.ts#L26)、路径见 :48-53）。
- 8:00 体检有确定性自检函数 `runDataWarmupSelfCheck`（[data-warmup-check.ts:26](../../src/app/data-warmup-check.ts#L26)）。
- 21:00 晚间产出的 `distillDailyKnowledge` 实际只做**软经验 lesson + 待审规则提案**两件事（`lessonsWritten` / `ruleProposalsCreated`，[distill-daily-knowledge.ts:56](../../src/app/distill-daily-knowledge.ts#L56)），**没有**在本文件里计算胜率/盈亏比/最大回撤。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 8:00 系统体检/冒烟 | 🟡部分 | [data-warmup-check.ts:26](../../src/app/data-warmup-check.ts#L26) | 自检账户/池/数据；是否含「Cron 状态检查」未查证 |
| 8:30 每日晨报 | ✅已实现 | [alarm-matrix.ts:35-42](../../src/domain/cerebellum/alarm-matrix.ts#L35-L42) + [alarm-brain.ts:109](../../src/app/alarm-brain.ts#L109) | `pre_market_plan` |
| 8:15 隔夜消息 | ✅已实现 | [alarm-matrix.ts:27-34](../../src/domain/cerebellum/alarm-matrix.ts#L27-L34) | 清单未单列，代码有 `overnight_digest` |
| 9:15 每日启动(补池100) | 🟡部分 | [alarm-matrix.ts:43-50](../../src/domain/cerebellum/alarm-matrix.ts#L43-L50) | 节点在；「补满100支」换血逻辑本会话未查证（见第5节） |
| 9:25 开盘确认 | ✅已实现 | [alarm-matrix.ts:51-58](../../src/domain/cerebellum/alarm-matrix.ts#L51-L58) | `pre_open_confirmation` |
| 10:30 必报(上午走势) | 🟡时间漂移 | [alarm-matrix.ts:59-66](../../src/domain/cerebellum/alarm-matrix.ts#L59-L66) | 实现为 **10:00** `morning_review` |
| 11:30 上午收盘 | ✅已实现 | [alarm-matrix.ts:67-74](../../src/domain/cerebellum/alarm-matrix.ts#L67-L74) | `midday_review` |
| 13:30 必报(午后跳水) | ❌缺失 | — | 无 13:30；最近 14:00 `afternoon_risk_scan` [:75-82](../../src/domain/cerebellum/alarm-matrix.ts#L75-L82) |
| 14:30 尾盘/炸板 | ✅已实现 | [alarm-matrix.ts:83-90](../../src/domain/cerebellum/alarm-matrix.ts#L83-L90) | `late_session_plan` |
| 15:00 收盘总结 | ✅已实现 | [alarm-matrix.ts:91-98](../../src/domain/cerebellum/alarm-matrix.ts#L91-L98) | `closing_snapshot`；另有 15:30 `post_close_review` [:99-106](../../src/domain/cerebellum/alarm-matrix.ts#L99-L106) |
| 20:30 盘后总结 | ✅已实现 | [alarm-matrix.ts:107-114](../../src/domain/cerebellum/alarm-matrix.ts#L107-L114) | `deep_review` |
| 21:00 晚间内省 | 🟡部分 | [alarm-matrix.ts:115-122](../../src/domain/cerebellum/alarm-matrix.ts#L115-L122) + [distill-daily-knowledge.ts:56](../../src/app/distill-daily-knowledge.ts#L56) | 软经验+规则提案有；「算力统计」「胜率/盈亏比/回撤」不在 distill |
| 链式静默巡航(逐分钟) | 🟡部分 | [silent-patrol.ts:19-30](../../src/domain/cerebellum/silent-patrol.ts#L19-L30)、[:240](../../src/domain/cerebellum/silent-patrol.ts#L240) | 10分钟栅格；开盘头15分钟的5分钟密集点(9:30/35/40/45)未覆盖 |
| 链式激活红线(±5%/大盘±1%) | ✅已实现 | [market-sentinel.ts:355-364](../../src/domain/cerebellum/market-sentinel.ts#L355-L364)、[index-risk-radar.ts:284-285](../../src/domain/cerebellum/index-risk-radar.ts#L284-L285) | 红线齐全且更丰富 |
| 周末 7 任务 | 🟡部分(1/7) | [alarm-matrix.ts:133-143](../../src/domain/cerebellum/alarm-matrix.ts#L133-L143) | 仅周六10:00 `weekly_review`；其余6个无独立节点 |
| 月度宏观(月初1号9:00) | 🟡时间+语义漂移 | [alarm-matrix.ts:144-154](../../src/domain/cerebellum/alarm-matrix.ts#L144-L154) | 实现为**月末20:00复盘**，非月初展望 |
| 年度展望(1月1号10:00) | 🟡时间+语义漂移 | [alarm-matrix.ts:155-166](../../src/domain/cerebellum/alarm-matrix.ts#L155-L166) | 实现为**12月31日20:00复盘**，非年初展望 |
| 必报 vs 🔕智能 分流 | ✅已实现 | 固定节点恒唤醒 vs silent-patrol [:166](../../src/domain/cerebellum/silent-patrol.ts#L166) | 两套机制并存 |

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 拍板并对齐必报点：10:30 vs 10:00、新增 13:30 午后跳水检查 | [alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts) + [alarm-sop.ts](../../src/domain/cerebellum/alarm-sop.ts) | Boss 拍板时间语义 |
| P0 | 补齐周末 6 任务（周六晨报/周度深度复盘/知识吸收/实盘周报/胜率复盘；周日晨报/知识吸收） | [alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts)、[alarm-sop.ts](../../src/domain/cerebellum/alarm-sop.ts)、[persist-period-review.ts](../../src/app/persist-period-review.ts) | 实盘周报/胜率是否接回测引擎 |
| P1 | 月度/年度拆「月末复盘(已有)」+「月初1号展望(新增)」「年初展望」两套 SOP | [alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts)、[alarm-sop.ts](../../src/domain/cerebellum/alarm-sop.ts) | — |
| P1 | 21:00 内省补「算力/token 统计」+「胜率/盈亏比/最大回撤」喂入 | [distill-daily-knowledge.ts](../../src/app/distill-daily-knowledge.ts)、daemon 侧累加器 | 算力统计数据源待定 |
| P2 | silent-patrol 支持「开盘头15分钟5分钟密集窗口」 | [silent-patrol.ts](../../src/domain/cerebellum/silent-patrol.ts) | 3秒哨兵已兜底异动，优先级低 |
| P2 | 链式激活升级为真正的「事件链信封」（携带 activationReason/nextCheckpoint），对齐 chat 路径已有的 wake-event envelope | [cerebellum-daemon.ts](../../scripts/dev/cerebellum-daemon.ts)、cerebellum 事件层 | 参考 openclaw system-events 模式 |

## 5. 开放问题 / 信息缺口（本会话未查证，勿当结论）

- **9:15「补满100支自选股」换血逻辑**：本会话只确认了 `call_auction_watch` 节点存在，没打开 `build-watchlist` / pool 换血代码确认「100池在哪个节点刷新、是否一次性补满」。需单独查证 `src/app/build-watchlist.ts` 及池刷新调用点。
- **胜率/盈亏比/最大回撤计算位置**：确认**不在** [distill-daily-knowledge.ts](../../src/app/distill-daily-knowledge.ts)（grep 无 hitRate/winRate/maxDrawdown/profitFactor）。memory 提到回测 P0 线有这些指标，但具体函数/文件本会话未定位。
- **算力/token 统计**：本会话未在代码中搜索是否存在 token 用量累计器，「21:00 算力统计」是否已实现属未知。
- **8:00 体检是否覆盖 Cron/daemon 自身健康**：只确认 `runDataWarmupSelfCheck` 存在（[data-warmup-check.ts:26](../../src/app/data-warmup-check.ts#L26)），未读函数体确认它检查哪些项。
- **report-generation.ts 的精确行为**：子代理报告称该文件生成四类报告，但本会话未亲自打开核对行号，不在本文件下结论。
- **SOP 模板是否 17 个 alarmType 全覆盖**：只确认 `buildCerebellumAlarmSopByType` 按类型分发（[alarm-sop.ts:323](../../src/domain/cerebellum/alarm-sop.ts#L323)），未逐一核对每个类型都有独立模板。

## 6. 触碰 / 相关文件清单（给后续并行分工用）

- [src/domain/cerebellum/alarm-matrix.ts](../../src/domain/cerebellum/alarm-matrix.ts) — 闹铃时间表（**高冲突区**，P0/P1 都动这里）
- [src/domain/cerebellum/alarm-sop.ts](../../src/domain/cerebellum/alarm-sop.ts) — 各节点 SOP 提示词
- [src/domain/cerebellum/silent-patrol.ts](../../src/domain/cerebellum/silent-patrol.ts) — 链式静默栅格
- [src/domain/cerebellum/market-sentinel.ts](../../src/domain/cerebellum/market-sentinel.ts) — 激活红线阈值
- [src/domain/cerebellum/index-risk-radar.ts](../../src/domain/cerebellum/index-risk-radar.ts) — 大盘 ±1% 系统性风险
- [src/infrastructure/scheduler/alarm-job-registry.ts](../../src/infrastructure/scheduler/alarm-job-registry.ts) — 每分钟轮询/去重
- [src/app/alarm-brain.ts](../../src/app/alarm-brain.ts) — 节点唤醒大脑分析
- [src/app/persist-period-review.ts](../../src/app/persist-period-review.ts) — 周/月/年复盘落盘
- [src/app/distill-daily-knowledge.ts](../../src/app/distill-daily-knowledge.ts) — 软经验+规则提案
- [src/app/data-warmup-check.ts](../../src/app/data-warmup-check.ts) — 8:00 自检
- [scripts/dev/cerebellum-daemon.ts](../../scripts/dev/cerebellum-daemon.ts) — 小脑常驻进程编排
