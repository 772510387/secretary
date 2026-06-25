# 成长式策略知识库（strategies/cases/decision_log + 五步增长闭环）是否落地

> 落盘时间：2026-06-25　会话标识：strategy-knowledge-base

## 1. 本会话探查范围
核对一条外部需求：「stock_knowledge_base：`strategies.json`（命名策略库，带胜率/状态）+ `cases.json`（案例库）+ `decision_log.json`（决策日志，关联 strategy_id）+ 五步增长闭环（决策前查库→决策记依据→事后回填结果→复盘沉淀案例/重算胜率→定期淘汰<40%/提拔>60%）」在 secretary 里是否实现。目标：给出逐能力点判定 + 用 agent/harness（参考 openclaw、Claude Code 记忆机制）而非纯 JSON CRUD 的改造方向。

## 2. 关键发现（必须带证据）
- **三件结构化文件（strategies.json / cases.json / decision_log.json）磁盘上不存在，`stock_knowledge_base/` 目录也不存在**：全仓 `find` 无命中；`memory/` 下只有 daily_logs/history/logs/long_term/market/plans/portfolio/proposals/reports/research/reviews/rules，没有 decisions 目录（实跑 `find` + `ls memory/`）。
- **代码里没有 `strategy_id` / `strategyId` 任何引用**：`grep -r strategy_id|strategyId src/` 无文件命中 → 需求第 2 步「决策关联策略」这根线全缺。
- **决策写盘机制已存在但是单向（只打分、不回填）**：`DecisionMemoryStore.writeDecision()` 落盘到 `memory/decisions/<asOfDate>/<decisionId>.json`，打分者固定为 `forward-return-scorer`，无 strategy_id 字段、无事后结果回写位（[src/infrastructure/storage/decision-memory.ts:49](src/infrastructure/storage/decision-memory.ts#L49)、[:100](src/infrastructure/storage/decision-memory.ts#L100)、[:107](src/infrastructure/storage/decision-memory.ts#L107)）。该目录当前磁盘上不存在（未见实跑产物）。
- **「策略」实为按市场状态分桶的 soft-lesson，无命名/无 ID/无 deprecated 生命周期**：schema 是 `regime{trend×rangeBucket×bias}` + hitRate/avgForwardReturn/verdict（[src/domain/decision/schemas.ts:217](src/domain/decision/schemas.ts#L217)）；决策打分汇总 [schemas.ts:134](src/domain/decision/schemas.ts#L134)、[:143](src/domain/decision/schemas.ts#L143)。
- **胜率是确定性算出来的（不是模型写的）**：`hits/sampleSize` 在 [src/app/distill-experience.ts:82](src/app/distill-experience.ts#L82)；回测打分 `hits/realized` 在 [src/app/score-replay.ts:126](src/app/score-replay.ts#L126)、[:172](src/app/score-replay.ts#L172)、[:188](src/app/score-replay.ts#L188)。这正是该复用的「统计引擎」。
- **沉淀（复盘）与反哺（盘前读教训）已有等价物，但产物是 markdown 散文不是案例/胜率**：21:00 沉淀 [src/app/distill-daily-knowledge.ts](src/app/distill-daily-knowledge.ts)；规则提案 [src/app/propose-rules.ts](src/app/propose-rules.ts)；盘前反哺 [src/app/load-knowledge-for-wake.ts](src/app/load-knowledge-for-wake.ts)（MEM-07）。
- **Agent 读写记忆工具已通电（MEM-05）**：`search_memory`（只读）+ `remember`（仅追加写）注册在 [src/app/brain-agent-tools.ts:307](src/app/brain-agent-tools.ts#L307)、[:339](src/app/brain-agent-tools.ts#L339)，底层固定追加路径 + schema + 脱敏 + 限长在 [src/app/model-memory.ts:168](src/app/model-memory.ts#L168)。**注意另有一套 brain tool-runtime surface**（`propose_memory_write` / `propose_trade_intent`，[src/domain/brain/tool-runtime.ts:241](src/domain/brain/tool-runtime.ts#L241)、[:246](src/domain/brain/tool-runtime.ts#L246)），与 brain-agent-tools 是两个工具面，哪个为驻留主链未核（见第 5 节）。
- **写治理已分级**：软写（daily_reflection/experience_summary/topic_logic/error_pattern/log_summary）自动追加，硬改走提案+人工复核（`AUTO_WRITE_TYPES` [src/domain/memory/write-policy.ts:13](src/domain/memory/write-policy.ts#L13)、门控 [:81](src/domain/memory/write-policy.ts#L81)）。→ 策略提拔/淘汰天然该走「硬改提案」。
- **检索是关键词非语义**：MemoryRegistry 分类检索 [src/infrastructure/storage/memory-registry.ts:27](src/infrastructure/storage/memory-registry.ts#L27)、[:55](src/infrastructure/storage/memory-registry.ts#L55)；向量检索 MEM-06 由 ADR 故意不做。
- **需求来源**：模块七「知识库进化与反哺机制（输入端复盘→沉淀端写 MEMORY/转规则→输出端盘前反哺）」在 [docs/requirements:164](docs/requirements#L164)-172（另有展开副本 [:699](docs/requirements#L699)）。对齐状态：MEM-05 ✅、MEM-07 ✅、MEM-06 🔴（[docs/requirements-alignment.md:228](docs/requirements-alignment.md#L228)-230）。**注意：requirements 模块七只描述了「散文教训→MEMORY/规则」的反哺，并未要求 strategies.json/cases.json/decision_log.json 这种结构化关系库**——那套结构是本会话核对的外部需求，secretary 自己的需求文档里没有它。

## 3. 现状判定（逐能力点）
| 能力点 | 状态 | 依据(file:line) | 备注 |
|---|---|---|---|
| `strategies.json` 命名策略库（ID+胜率+active/deprecated） | ❌ 缺失 | find 无命中；[schemas.ts:217](src/domain/decision/schemas.ts#L217) | 现状是 regime 分桶 soft-lesson，无命名/无生命周期 |
| `cases.json` 案例库（成功/失败/持仓中 + 盈亏） | ❌ 缺失 | find 无命中 | 决策被打分但不沉淀成可检索案例 |
| `decision_log.json`（含 strategy_id 关联） | 🟡 部分 | [decision-memory.ts:49](src/infrastructure/storage/decision-memory.ts#L49)；strategy_id grep 无命中 | 决策按日落盘但单向、无 strategy_id、无结果回填 |
| 步骤1 决策前查库（命中命名策略+胜率） | 🟡 部分 | [load-knowledge-for-wake.ts](src/app/load-knowledge-for-wake.ts) | 读的是散文教训，非结构化策略命中 |
| 步骤2 决策记依据（基于哪条策略） | 🟡 部分 | strategy_id grep 无命中 | 写决策有，缺 strategy_id 字段 |
| 步骤3 事后回填结果 | 🟡 部分 | [score-replay.ts:126](src/app/score-replay.ts#L126)；decision-memory 无回写位 | 能算结果，但不回写日志、不给案例打成功/持仓中 |
| 步骤4 复盘沉淀（案例+重算胜率） | 🟡 部分 | [distill-daily-knowledge.ts](src/app/distill-daily-knowledge.ts)、[distill-experience.ts:82](src/app/distill-experience.ts#L82) | 产 markdown 教训+规则提案，非案例/命名胜率 |
| 步骤5 定期淘汰<40%/提拔>60% | 🟡 部分 | [propose-rules.ts](src/app/propose-rules.ts) | 按状态桶 verdict 提案，无命名策略 deprecated/promote 动作 |
| Agent 记忆读写工具 | ✅ 已实现 | [brain-agent-tools.ts:307](src/app/brain-agent-tools.ts#L307)、[model-memory.ts:168](src/app/model-memory.ts#L168) | `search_memory`+`remember`，带护栏（MEM-05） |
| 写治理（软自动/硬提案） | ✅ 已实现 | [write-policy.ts:13](src/domain/memory/write-policy.ts#L13) | 策略提拔/淘汰可直接挂硬改提案链 |
| 语义/向量检索 | ❌ 缺失（故意） | MEM-06，[memory-registry.ts:55](src/infrastructure/storage/memory-registry.ts#L55) | ADR 决定只做关键词 |

**总判**：需求设想的「结构化策略关系库」基本未实现；但它要的「成长闭环」的统计引擎（regime 打分）、写治理、agent 记忆工具、沉淀/反哺节点都已存在，只是产物是散文+状态桶、缺「命名策略」这层本体与 strategy_id 这根线。本质是**接环 + 桥接两套本体论**，不是从零造库。

## 4. 待办 / 改造建议（按优先级）
**✅ 已选定方案 B（桥接派，2026-06-25 拍板）**：命名策略作为人面向的一层，叠在现有 regime 打分器 + 记忆系统之上，统计自动归因，闭环挂在已有时钟节点上。**不**另起 strategies.json/cases.json/decision_log.json 关系库（方案 A 否决，理由：会与 score-replay/distill/write-policy 三套已验证机制并存为两套皮）。

**方法取向（参考 openclaw / Claude Code 记忆机制，避免纯 JSON CRUD）**：① 命名策略=带 frontmatter（id/win_rate/status/sample_size）的记忆记录 + 轻量索引，案例用 `[[BUY-001]]` 反链——即 Claude Code 自身「一文件一事实+MEMORY 索引」那套；② 胜率永远派生不让模型写，由 scorer 从决策日志结果算（openclaw「压缩即知识生产」的 post-sync 思路）；③ 调度/召回注入/统计归确定性小脑，模型只拿带护栏的小工具（脑/小脑/手分工）。**桥接核心**：每条命名策略声明自己的 regime 指纹，让现有 regime 打分自动归因到命名策略，复用而非重造统计引擎。

| 优先级 | 事项 | 预计触碰文件 | 依赖 |
|---|---|---|---|
| P0 | 决策 schema 加 `strategy_id`（可多条），模型决策必须引用「基于哪条策略」 | [src/domain/decision/schemas.ts](src/domain/decision/schemas.ts)、决策生成处 | 需先定命名策略集 |
| P0 | 验证 T+1 跨日卖出能真正平仓（步骤3 回填的前提，见第 5 节） | HAND-02/03 相关结算代码 | 阻塞步骤3 |
| P1 | 命名策略层：每条策略=记忆记录（frontmatter: id/regime 指纹/status/sample_size），统计字段由 scorer 归因回填 | 新增 `src/domain/strategy/*`、复用 [score-replay.ts](src/app/score-replay.ts)、[distill-experience.ts](src/app/distill-experience.ts) | strategy_id 落地 |
| P1 | 决策日志「结果回填」：scorer 算完把 outcome 写回那条决策 + 给案例打 成功/失败/持仓中 | [decision-memory.ts](src/infrastructure/storage/decision-memory.ts)、[score-replay.ts](src/app/score-replay.ts) | T+1 验证、strategy_id |
| P1 | 决策前召回：`query_strategy(setup)` 把命中命名策略+派生胜率/样本注入漏斗上下文（不只散文） | [load-knowledge-for-wake.ts](src/app/load-knowledge-for-wake.ts)、[brain-agent-tools.ts](src/app/brain-agent-tools.ts) | 命名策略层 |
| P2 | 复盘沉淀升级为 consolidation：从已平仓决策生成/追加案例、重算每条命名策略胜率 | [distill-daily-knowledge.ts](src/app/distill-daily-knowledge.ts) | 结果回填 |
| P2 | 策略生命周期：<40% 提淘汰、>60% 提提拔，走硬改提案+人工复核（不自动改库） | [propose-rules.ts](src/app/propose-rules.ts)、[write-policy.ts](src/domain/memory/write-policy.ts) | consolidation |
| P3 | 扩展：近因加权胜率+漂移告警、失败案例编译成小脑硬前置检查、置信区间诚实牌（防小样本 100% 过拟合）、自荐新命名策略、策略冲突显式抛给脑 | 上述各处 | 闭环跑通后 |

## 5. 开放问题 / 信息缺口
- **T+1 跨日 rollover 是否真修好未亲验**：本会话记忆（2026-06-24 审计）记为「持仓卖不出真 bug」，隔夜报告 HAND-02/03 称已修，但我没跑过、没读结算代码确认。步骤3「回填结果」依赖它，落地前必须 `/verify`。
- **`memory/decisions/` 目录磁盘上不存在的原因未追**：是打分链从未实跑、还是被清理、还是驻留 daemon 没接？只确认了 store 代码存在。
- **两套工具面（tool-runtime 的 `propose_memory_write`/`propose_trade_intent` vs brain-agent-tools 的 `remember`/`search_memory`）哪个是驻留主链、是否有一个是 legacy，未追驻留 daemon 的实际接线**。
- **distill-daily-knowledge / long_term 是否真有产物未查**：`long_term/` 目录在，但没读内容确认沉淀实际跑出过文件。
- **openclaw 借鉴细节来自子 agent 探查报告，未逐行复核**：其「memory 插件化后端、compaction 即知识生产、before-finalize 复核钩子」等结论可信但属转述。
- ~~方案 A vs 方案 B 拍板~~ → **已拍板方案 B（桥接派），2026-06-25**。此项关闭。

## 6. 触碰 / 相关文件清单（给后续并行分工用，避免冲突）
- [src/domain/decision/schemas.ts](src/domain/decision/schemas.ts) — 决策/打分/soft-lesson schema（加 strategy_id 会动这里，**高冲突**）
- [src/infrastructure/storage/decision-memory.ts](src/infrastructure/storage/decision-memory.ts) — 决策落盘 + 结果回填
- [src/app/score-replay.ts](src/app/score-replay.ts) — 胜率/forward-return 统计引擎
- [src/app/distill-experience.ts](src/app/distill-experience.ts) — regime 分桶胜率
- [src/app/distill-daily-knowledge.ts](src/app/distill-daily-knowledge.ts) — 21:00 沉淀（升级为 consolidation）
- [src/app/propose-rules.ts](src/app/propose-rules.ts) — 规则/策略生命周期提案
- [src/app/load-knowledge-for-wake.ts](src/app/load-knowledge-for-wake.ts) — 盘前反哺/召回
- [src/app/brain-agent-tools.ts](src/app/brain-agent-tools.ts) + [src/app/model-memory.ts](src/app/model-memory.ts) — agent 记忆工具（search_memory/remember）
- [src/domain/brain/tool-runtime.ts](src/domain/brain/tool-runtime.ts) — 另一套 brain 工具面（propose_*）
- [src/domain/memory/write-policy.ts](src/domain/memory/write-policy.ts) — 软/硬写治理
- [src/infrastructure/storage/memory-registry.ts](src/infrastructure/storage/memory-registry.ts) — 关键词检索
- 新增（建议）：`src/domain/strategy/*` — 命名策略层（regime 指纹→归因）
- T+1 跨日结算代码（HAND-02/03，路径待定位）— 步骤3 前提
