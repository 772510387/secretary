# 复盘行为：现状是"模型口算口编"，缺确定性事实层 + 防幻觉叙述契约

> 落盘时间：2026-06-25　会话标识：review-grounding

## 1. 本会话探查范围
对照用户贴出的"日度/周度复盘报告 + 决策逻辑追问"样本，确定**复盘(retrospective)能力**在代码里实现到什么程度。核心目标：判断这些漂亮报告是"真从账本算出来的"还是"模型即兴生成的"，并定改造方向。结论先行——**是后者**，所以问题本质是 grounding（接地），不是文案。

## 2. 关键发现（必须带证据）

- **复盘报告里的多项数字在代码里根本没有计算来源，是模型编的。** 全 `src/` 搜 `sharpe/annualized/年化/夏普` **零命中**——而样本报告里写了"夏普比率 高""年化约+2800%"。样本里"其他持仓浮动 404 元（计算误差修正）"也是为凑日盈亏硬塞的修正项。这两点直接证明复盘是自由叙述。
- **真实成交账本只存 UTC 时间戳，京日只是一个日期字段** → 这就是样本里反复纠缠"UTC 04:35 = 北京 12:35"的根因。trade 记录 `tradedAt` 是 `isoDateTimeSchema`(UTC，实测行 `"tradedAt":"2026-06-25T01:1…Z"`)，`tradeDate` 才是北京日期 `src/domain/portfolio/schemas.ts:132-133`。展示层没有北京时间归一。
- **每笔成交不带"理由"字段**；理由在上一层 proposal 的 `rationale`，复盘要 join 才能还原。trade schema 只有可选 `note`(max500，实测落库行里根本没写) `src/domain/portfolio/schemas.ts:135`；理由真正落盘在 `src/domain/memory/schemas.ts:389`(`rationale` max2000) 和脑工具入参 `src/app/brain-agent-tools.ts:85,251,396`。
- **样本里那套"前一天定的 -3% 减仓计划 / 58.50 减仓线 / 分批止盈梯度 / -7加-3减+5止盈+10持有"在代码里没有任何持久化的家。** 域内只有三个数字常量：`dailyLossLimitRatio 0.03`、`hardStopLossRatio 0.08`、`maxSinglePositionRatio 0.4`(`src/config/schema.ts:52-54`、`src/domain/risk/risk-engine.ts:293`)。软纪律只以自然语言活在 prompt 里(`src/app/alarm-brain.ts:64,75,81` 的"止盈位/止损位"措辞)，**不是结构化数据**。所以"参数怎么定的"只能现编。
- **日 snapshot 不存指数**，无法事后做诚实的"超额收益"。`src/app/archive-daily-snapshot.ts` 全文无 index/benchmark；指数 provider 单独存在(`src/infrastructure/providers/tencent-index-provider.ts:31-34` 上证/深证/创业板/科创50)，只当脑的上下文，不进账本。
- **回撤指标是"代理方向性 equity"，不是真金资金曲线。** `src/app/equity-curve.ts:12-13` 注释自承 "directional-quality gauge, NOT [real money]"；maxDrawdown 在 `:37,:51,:61`。真实资金曲线/夏普/年化均无。
- **"胜率"现状是按市场 regime 的命中率，可空，不是逐笔交易胜率。** `src/domain/decision/schemas.ts:138`(`hitRate … nullable`)。样本里的"胜率75%"无对应计算。

## 3. 现状判定（逐能力点）

| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| 日度资产/盈亏/涨幅(昨→今) | 🟡部分 | `src/app/archive-daily-snapshot.ts:97`(daily-summary.jsonl) | 落了每日单行，但无昨→今 delta、无日涨幅%、无已实现/浮动拆分 |
| 周度汇总(初始→当前/周涨幅/逐日) | ❌缺失 | `src/app/persist-period-review.ts:26,48-49` | 只有存 weekly md 的路由框架，无任何周度 P&L 聚合 |
| 操作时间线(时间·价·量·理由) | 🟡部分 | `src/app/daily-fills-ledger.ts:21,33-35` | 只渲染"共N笔/买卖金额"，**无逐笔时间、无北京时间、无理由** |
| 已实现 vs 浮动盈亏拆分 | 🟡部分 | `src/domain/portfolio/calculations.ts:101,105` | 有持仓浮盈/浮盈率；**无卖出按成本配对的已实现 P&L** |
| 仓位 | ✅已实现 | `src/domain/portfolio/calculations.ts:230,272` | positionRatio / investedRatio |
| 最大回撤 | 🟡部分 | `src/app/equity-curve.ts:37,51,61` | 仅代理方向性曲线，非真金 |
| 夏普 / 年化 / 真实资金曲线 | ❌缺失 | 全 `src/` 搜 sharpe/年化 零命中 | 样本里的值是编的 |
| 胜率 | 🟡部分 | `src/domain/decision/schemas.ts:138` | 是 regime 命中率，非逐笔交易胜率 |
| 对比大盘 / 超额 | 🟡部分 | `src/infrastructure/providers/tencent-index-provider.ts:31-34,193` | 指数能拉，但无组合 vs 指数对比、无超额、日 snapshot 不存指数 |
| 决策理由可回溯 | 🟡部分 | `src/domain/memory/schemas.ts:389`；`src/app/brain-agent-tools.ts:85,251,396` | rationale 已持久化，可 `trade→intentId→proposal` join；但需显式 join，非外键 |
| 决策"计划/点位"可回溯 | ❌缺失 | 见第5节(未发现持久化) | 减仓线/止盈梯度/仓位目标决策时未落库 |
| 交易纪律为结构化数据 | ❌缺失 | `src/config/schema.ts:52-55`(仅硬风控) vs `src/app/alarm-brain.ts:64,75,81`(软纪律在 prompt) | -7/-3/+5/+10 既不在 config 也不在数据 |
| 时间戳北京归一(展示) | ❌缺失 | `src/domain/portfolio/schemas.ts:133`(tradedAt=UTC) | 时区混乱根因 |
| 追问应答准确性 | ❌正在失败 | 样本即证据(200/100、UTC、404修正) | 根因=自由叙述未接地 |
| 收盘复盘报告生成(框架) | 🟡部分 | `src/app/report-generation.ts:30-33` | 有 closing_review/daily_reflection 类型，但是脑生成建议，非接地的 P&L 复盘 |

## 4. 待办 / 改造建议（按优先级）

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | **复盘事实包 `build复盘FactPack(date)`**：确定性算昨→今资产/日盈亏/日涨幅/已实现vs浮动/仓位/逐笔时间线，所有数字算死，模型只接收不计算 | 新增 `src/app/build-review-factpack.ts`；读 `src/domain/portfolio/calculations.ts`、trades.jsonl、`archive-daily-snapshot.ts` | 已实现P&L需卖出配成本 |
| P0 | **时间在边界做北京归一**：`tradedAt`(UTC)→北京展示串在事实包里算好，绝不留给模型 | 复用 batch10 的北京时间 util；接入 `daily-fills-ledger.ts` 时间线 | 无 |
| P0 | **数字契约 + 复盘校验器**：叙述里每个数字/股数/时间必须能在事实包里找到原值；渲染后 grep 数字×对 fact pack，对不上打回(借 openclaw validate-before-accept) | 新增 review narrator + checker | 事实包先行 |
| P1 | **理由读回而非再生成**：复盘 `trade→intentId→proposal.rationale` join；缺则写"未记录"，禁编 | `src/app/brain-agent-tools.ts`、proposal 存储 | 无 |
| P1 | **决策时落"计划/点位"**：把模型设的止损/减仓位/仓位目标随提案落库，供复盘引用 | 扩 `src/domain/memory/schemas.ts` proposal.metadata 或新建 trade-plan 记忆 | 无 |
| P1 | **策略卡(数据化纪律+来由+版本)**：软纪律与 provenance 结构化，决策与复盘都引用 | 新增 `docs/stock-strategy/` 策略卡 + config | 无 |
| P1 | **日存指数快照 + 超额计算**：snapshot 里存当日指数收盘，诚实累积超额曲线 | `src/app/archive-daily-snapshot.ts`、index provider | 无 |
| P1 | **周度=日事实包确定性聚合**，不二次叙述 | 新增 weekly 聚合，喂 `persist-period-review.ts` | 日事实包 |
| P1 | **复盘 SOP 节点**：收盘触发日复盘、周五收盘触发周复盘，确定性优先→叙述→校验→推送(遵守现有 push 噪音策略) | 小脑 alarm SOP | 事实包+校验器 |

## 5. 开放问题 / 信息缺口（本会话未亲自核验，勿当结论）

- **`daily-summary.jsonl` 每行的确切字段 shape 未读**：只确认了写入路径(`archive-daily-snapshot.ts:97`)，没核对每行存了哪些字段、t-1 资产是否可直接 diff 出来。做 P0 事实包前需读 `archiveDailySnapshot()` 写入 payload。
- **"计划/点位"是否真的全无持久化**：grep 未发现减仓线/止盈梯度的落库点，但未穷举搜索；判定为"未发现"，非"确认不存在"。
- **proposal.rationale 是否对每笔已执行交易都可靠存在**：只确认了 funnel 选股路径写 rationale；手动/其它下单路径是否一定有，未验证。
- **closing_review / daily_reflection 是否真推 Feishu、是否含 P&L**：只确认了 report 类型枚举(`report-generation.ts:30-33`)，未追投递与内容。
- **backtest/replay/walk-forward 自我进化线(replay→score→experience→rule-proposal)**：另一并行探查报告称其完整存在(`replay-runner.ts`/`score-replay.ts`/`distill-experience.ts`/`propose-rules.ts`/`walk-forward-runner.ts`)，但**本会话未亲自核验这些行号**；与复盘叙事的接线关系待确认。引用前请自查。
- **lotSize/T+1** 等约束(`src/config/schema.ts:38`)与复盘"逐笔可卖量"展示的接线未追。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）

- `src/app/archive-daily-snapshot.ts` —（P0/P1 都会动：事实包数据源 + 存指数）
- `src/app/daily-fills-ledger.ts` —（P0：时间线 + 北京时间 + 理由 join）
- `src/app/build-review-factpack.ts`（**新增**，P0 核心）
- `src/domain/portfolio/calculations.ts` —（已实现P&L/真实资金曲线/夏普 可能扩这里）
- `src/app/equity-curve.ts` —（真金资金曲线若替换代理曲线会动）
- `src/domain/memory/schemas.ts` —（P1：proposal 增"计划/点位"）
- `src/app/brain-agent-tools.ts` —（理由 join / 落计划）
- `src/infrastructure/providers/tencent-index-provider.ts` —（超额对比取数）
- `src/app/persist-period-review.ts` —（周度聚合接线）
- `src/app/report-generation.ts` —（closing_review 切成接地复盘）
- 小脑 alarm SOP（复盘节点）—（与 sealing-order / sector-heat 等节点改造可能撞同一调度文件，注意协调）
