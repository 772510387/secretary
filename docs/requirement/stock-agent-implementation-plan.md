# Secretary A 股智能体实现方案与清单

生成日期：2026-06-12  
目标路径：`D:\Project\main\secretary`  
需求来源：`docs/requirements` 中的 OpenClaw 原型构建记录与后续架构确认

## 1. 目标判断

`secretary` 要实现的不是 OpenClaw 的复制品，而是一个独立的 A 股模拟盘/交易辅助智能体运行时。

核心原则：

> 凡是确定的，归于代码；凡是混沌的，归于 AI。

因此系统必须把“眼、手、记忆、小脑、大脑”拆开：

- 眼：行情抓取、历史 K 线、技术指标、盘口快照，全部工程化。
- 手：交易模拟、账本写入、硬性风控、T+1、仓位限制，全部工程化。
- 记忆：文件夹式记忆库、索引、检索、写入策略，全部工程化。
- 小脑：北京时间闹钟、3 秒哨兵、异动检测、上下文投喂，全部工程化。
- 大脑：政策解读、题材理解、策略推演、复盘反思、自然语言汇报、自我修正建议。

OpenClaw 只作为原型资产来源，不作为 `secretary` 的运行依赖。

## 2. 关键非目标

第一版不做这些事：

- 不接真实券商交易接口，只做模拟盘和辅助决策。
- 不让大模型直接修改账户 JSON、规则文件或执行交易。
- 不迁移整个 OpenClaw 仓库。
- 不依赖 OpenClaw Cron、`openclaw system event` 或 OpenClaw 工具宿主。
- 不把长期记忆塞进单个 `MEMORY.md` 文件。

## 3. 推荐技术方案

### 3.1 语言与运行时

推荐使用 TypeScript + Node.js。

理由：

- 现有原型脚本是 Node.js，迁移成本最低。
- 常驻小脑、行情轮询、文件读写、定时任务都适合 Node。
- TypeScript 可以把数据结构、事件类型、风控入参约束清楚。

### 3.2 存储

第一阶段继续使用 JSON 文件，配合严格 schema 校验、原子写入和备份。

后续可迁移到 SQLite：

- 当交易流水、日志、记忆索引明显增多时再迁移。
- 不要第一版就引入数据库复杂度。

### 3.3 大脑模型接入

抽象统一接口：

```ts
interface BrainProvider {
  complete(input: BrainInput): Promise<BrainOutput>;
}
```

实现多个 provider：

- `OpenAIProvider`
- `GeminiProvider`
- `DashScopeQwenProvider`

上层业务只依赖 `BrainProvider`，通过配置切换：

```env
BRAIN_PROVIDER=gemini
OPENAI_API_KEY=
GEMINI_API_KEY=
DASHSCOPE_API_KEY=
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_MODEL=
TIMEZONE=Asia/Shanghai
```

不同供应商的 function calling / tool calling 能力不一致，第一版建议统一走后端工具运行时：

1. 小脑生成结构化任务包。
2. 大脑返回结构化建议和工具请求。
3. 后端校验工具请求。
4. 后端执行工具。
5. 后端落审计日志。

## 4. 总体架构

```text
外部行情源
   |
   v
market/QuoteProvider -----> market/HistoryProvider
   |                              |
   v                              v
cerebellum/Radar ----------> portfolio/RiskEngine
   |                              |
   v                              v
cerebellum/EventBus -------> brain/BrainService
   |                              |
   v                              v
memory/MemoryStore <------ tools/ToolRuntime
   |
   v
notifier/Notifier
```

模块职责：

- `market`：只负责获取真实行情和历史数据。
- `portfolio`：只负责账户、持仓、交易和硬性风控。
- `memory`：只负责记忆库的读、写、索引、检索、审计。
- `cerebellum`：只负责调度、哨兵、事件触发和 prompt 上下文组装。
- `brain`：只负责调用模型，并把模型输出转成可校验的建议。
- `tools`：大脑可请求的能力集合，但最终执行权在后端。
- `notifier`：把结论发到控制台、文件、Webhook 或微信。

## 5. 推荐目录结构

```text
secretary/
  src/
    main.ts
    config/
      env.ts
      thresholds.ts
      schedules.ts
    market/
      quote-provider.ts
      tencent-quote-provider.ts
      history-provider.ts
      indicators.ts
    portfolio/
      portfolio-store.ts
      trade-engine.ts
      risk-engine.ts
      position-lots.ts
      schemas.ts
    cerebellum/
      scheduler.ts
      radar.ts
      event-bus.ts
      prompt-builder.ts
      context-builder.ts
    brain/
      brain-provider.ts
      brain-service.ts
      openai-provider.ts
      gemini-provider.ts
      dashscope-qwen-provider.ts
      output-parser.ts
    memory/
      memory-registry.ts
      memory-store.ts
      memory-search.ts
      memory-write-policy.ts
      memory-indexer.ts
    tools/
      tool-runtime.ts
      read-portfolio-tool.ts
      get-quotes-tool.ts
      fetch-history-tool.ts
      execute-trade-tool.ts
      memory-search-tool.ts
      memory-write-tool.ts
    notifier/
      notifier.ts
      console-notifier.ts
      file-notifier.ts
      webhook-notifier.ts
    logging/
      logger.ts
      audit-log.ts
    utils/
      beijing-time.ts
      atomic-json.ts
      ids.ts
  data/
    stock_database.json
    memory/
      MEMORY_INDEX.md
      rules/
      long_term/
      daily_logs/
      prediction_logs/
      execution_logs/
      weekly_reviews/
      monthly_reviews/
      yearly_reviews/
      history/
      proposals/
      audit/
  docs/
    requirement/
      stock-agent-implementation-plan.md
```

## 6. 数据流设计

### 6.1 盘中哨兵流

1. `Radar` 在交易时段内每 3 秒触发一次。
2. `QuoteProvider` 拉取持仓股、高优先级自选股、大盘指数。
3. `PortfolioStore` 更新当前价格、浮盈浮亏、账户快照。
4. `RiskEngine` 检查异动：
   - 大盘 1 分钟闪崩超过 0.5%。
   - 持仓股 1 分钟急涨/急跌超过 2%。
   - 持仓股绝对涨跌幅超过 5%。
   - 高优先级自选股跌幅超过 5%。
   - 个股跌破成本价 8%。
5. 命中条件时写入 `data/memory/audit/events-YYYY-MM-DD.jsonl`。
6. 通过 `EventBus` 触发大脑。
7. `BrainService` 读取真实上下文后生成分析和汇报。
8. `Notifier` 发送结果。

### 6.2 固定闹钟流

1. `Scheduler` 使用 `Asia/Shanghai` 时间判断任务。
2. 到点后先由工程代码准备上下文：
   - 当前账户。
   - 持仓行情。
   - 当日市场更新。
   - 相关规则。
   - 近期记忆。
3. `PromptBuilder` 生成当前闹钟的 SOP。
4. `BrainService` 调用当前模型供应商。
5. 大脑输出必须经过结构化解析。
6. 如涉及写记忆或交易，必须走 `ToolRuntime` 二次校验。
7. 所有输出写入日志。

### 6.3 On-Demand 查询流

用户询问“现在盘面怎么样”时：

1. 后端立即调用 `QuoteProvider` 刷新行情。
2. 读取账户与相关记忆。
3. 触发 `BrainService` 生成即时分析。
4. 不依赖固定闹钟。

### 6.4 自进化写入流

自进化不能等同于“大模型想改什么就改什么”。

正确流程：

1. 大脑基于预测日志、执行日志、行情历史、交易结果提出修正建议。
2. 建议写入 `memory/proposals/`，包括证据、原因、影响范围、置信度。
3. `MemoryWritePolicy` 判断建议类型：
   - 红线规则：只能提出 proposal，不能自动削弱。
   - 软阈值：可在安全范围内自动小幅调整。
   - 经验总结：可直接写入长期记忆。
   - 每日日志：可直接写入场景记忆。
4. 所有写入必须带证据引用和审计记录。

## 7. 北京时间策略

所有闹钟和交易时段判断必须使用北京时间。

实现要求：

- 配置固定为 `Asia/Shanghai`。
- 不依赖操作系统本地时区。
- 封装 `getBeijingNow()`、`getBeijingDateKey()`、`getBeijingHHMM()`。
- 单元测试覆盖：
  - 周六 10:00 周复盘。
  - 月末 20:00 月复盘。
  - 12-31 20:00 年复盘。
  - 交易日 09:15-11:30、13:00-15:00。

推荐实现：

```ts
type BeijingClock = {
  date: string;       // YYYY-MM-DD
  hhmm: string;       // HH:mm
  weekday: number;    // 1-7, Monday-Sunday
  isMonthEnd: boolean;
  isYearEnd: boolean;
};
```

## 8. 核心数据模型

### 8.1 账户数据库

`data/stock_database.json` 保留原型结构，但需要 schema 化：

- `database_info`
- `account_summary`
- `current_positions`
- `position_lots`
- `watchlist_pool`
- `watchlist_stocks`
- `potential_pool`
- `trade_history`
- `daily_snapshots`
- `daily_summary`
- `performance_metrics`

新增建议：

```json
{
  "position_lots": [
    {
      "lot_id": "LOT-20260612-000636-001",
      "code": "000636",
      "shares": 100,
      "buy_date": "2026-06-12",
      "available_from": "2026-06-13",
      "avg_cost": 61.6
    }
  ]
}
```

原因：T+1 不能只看聚合持仓，必须知道每一批买入什么时候可卖。

### 8.2 记忆库

```text
data/memory/
  MEMORY_INDEX.md
  rules/
    00_core_principles.md
    01_trading_rules.md
    02_stop_loss_rules.md
    03_sword_shield.md
    04_threshold_policy.md
  long_term/
    2026-06/
      week2_learnings.md
      month_summary.md
    topic_*.md
  daily_logs/
    2026-06/
      2026-06-12.md
  prediction_logs/
    2026-06/
      2026-06-12.md
  execution_logs/
    2026-06/
      2026-06-12.md
  weekly_reviews/
  monthly_reviews/
  yearly_reviews/
  history/
  proposals/
  audit/
```

## 9. 风控和交易硬拦截

`TradeEngine` 必须实现以下硬拦截：

- 股票代码必须属于主板：`000xxx`、`600xxx`、`601xxx`、`603xxx`。
- 禁止 `300xxx` 创业板。
- 禁止 `688xxx` 科创板。
- 禁止 `8xxxxx`、`4xxxxx` 北交所。
- 买卖股数必须为 100 的整数倍。
- 价格必须大于 0。
- 买入金额不能超过可用现金。
- 单股买入后市值不能超过总资产的 40%。
- 卖出不能超过可用持仓。
- 当日买入批次不可当日卖出，严格 T+1。
- 跌破成本 8% 的硬止损由 `RiskEngine` 触发，不由大模型判断。

注意：这些规则必须写在代码里，不能只写在 prompt 或记忆中。

## 10. 小脑闹钟矩阵

所有时间为北京时间。

### 10.1 交易日固定闹钟

| 时间 | 类型 | 工程动作 | 大脑任务 |
| --- | --- | --- | --- |
| 08:00 | 体检 | 检查数据文件、行情接口、provider 配置 | 输出系统状态 |
| 08:15 | 消息预热 | 准备持仓、规则、搜索任务提示 | 解读隔夜外盘、政策、新闻 |
| 08:30 | 晨报策略 | 准备账户、规则、近期经验 | 生成当日剧本、关注池和潜力池建议 |
| 09:15 | 集合竞价 | 刷新关注池和竞价数据 | 判断情绪、一字板、新题材 |
| 09:25 | 开盘确认 | 刷新实时行情 | 验证骗线、高开低走、第一策略 |
| 10:00 | 早盘总结 | 更新账户、持仓、主线候选 | 剑盾双修决策 |
| 11:30 | 午盘总结 | 归档上午快照 | 制定午后应对 |
| 14:00 | 风险排查 | 检查大盘跳水、持仓破位 | 防守优先级判断 |
| 14:30 | 尾盘监控 | 检查抢筹/砸盘 | 尾盘动作建议 |
| 15:00 | 收盘战报 | 更新收盘价格 | 汇报当日账户和操作 |
| 15:05 | 快照归档 | 写 daily snapshot | 不必唤醒大脑 |
| 15:30 | 龙虎榜/资金 | 准备搜索任务和持仓 | 判断主力意图、题材验证 |
| 20:30 | 深度复盘 | 准备账单、交易流水、预测日志 | 提炼经验，写长期记忆 |
| 21:00 | 晚间学习 | 准备知识库上下文 | 形成黑话/策略学习笔记 |
| 00:00 | 午夜自省 | 拉历史 K 线，准备预测 vs 实际 | 修正判断逻辑、阈值、策略提案 |

### 10.2 长周期闹钟

| 时间 | 触发条件 | 大脑任务 | 写入位置 |
| --- | --- | --- | --- |
| 周六 10:00 | `weekday === 6` | 周度复盘、胜率、回撤、下周策略 | `weekly_reviews/`、`long_term/` |
| 月末 20:00 | `isMonthEnd === true` | 月度大考、风格校准、规则提案 | `monthly_reviews/`、`long_term/` |
| 12-31 20:00 | `isYearEnd === true` | 年度复盘、新年交易宪法提案 | `yearly_reviews/`、`rules/proposals` |

## 11. 大脑提示词策略

每个小脑事件都应包含四层内容：

1. 全局纪律：
   - 主板限制。
   - T+1。
   - 不直接改账。
   - 所有数据以工具读取为准。
2. 本次任务：
   - 当前时间点。
   - 任务目标。
   - 必须读取的数据。
   - 必须回答的问题。
3. 可用工具：
   - `readPortfolio`
   - `getQuotes`
   - `fetchHistory`
   - `searchMemory`
   - `proposeMemoryWrite`
   - `executeTrade`
4. 输出格式：
   - 面向用户的简短结论。
   - 结构化建议。
   - 工具请求。
   - 记忆写入请求。

## 12. 记忆读取策略

大脑不应该凭记忆工作。小脑必须按场景提供读取指引。

| 场景 | 必读记忆 |
| --- | --- |
| 盘前晨报 | `stock_database.json`、`rules/`、最近 `long_term/`、昨日 `daily_logs/` |
| 盘中异动 | 当前行情、持仓、成本、硬规则、该股历史 K 线 |
| 交易执行前 | 交易规则、账户、可用现金、position lots、当前报价 |
| 15:00 收盘 | 账户、交易流水、当日行情、执行日志 |
| 20:30 复盘 | 预测日志、执行日志、交易流水、daily snapshot、长期经验 |
| 00:00 自省 | 当日预测 vs 实际、历史 K 线、规则、近期连续错误 |
| 周/月/年复盘 | 汇总快照、交易流水、收益曲线、长期经验、proposal 历史 |

## 13. 记忆写入策略

### 13.1 工程自动写入

这些不需要大脑参与：

- 行情更新日志。
- 交易流水。
- 账户快照。
- 风控事件。
- 工具调用审计。
- prompt 输入摘要。
- 模型输出摘要。

### 13.2 大脑参与写入

大脑只写或提议写这些：

- 每日复盘文字。
- 策略经验。
- 题材逻辑。
- 错误模式。
- 阈值调整提案。
- 规则修订提案。

### 13.3 写入请求格式

建议大脑输出：

```json
{
  "type": "memory_write_request",
  "target_category": "long_term",
  "target_path": "data/memory/long_term/2026-06/week2_learnings.md",
  "change_type": "append_experience",
  "title": "高开低走后的持仓处理",
  "evidence_refs": [
    "prediction_logs/2026-06/2026-06-12.md",
    "execution_logs/2026-06/2026-06-12.md",
    "history/000636_history.json"
  ],
  "content": "经验正文",
  "confidence": 0.78,
  "requires_approval": false
}
```

### 13.4 自动应用边界

可以自动写入：

- 日志。
- 复盘。
- 经验。
- 题材理解。
- 错误模式。

默认只提案，不自动应用：

- 修改硬规则。
- 放宽主板限制。
- 放宽 T+1。
- 放宽止损。
- 大幅调整仓位上限。

可小幅自动调整：

- 软阈值，例如观察阈值、题材评分权重、提醒频率。
- 调整必须在配置限定范围内，并写审计日志。

## 14. 多模型大脑策略

`BrainService` 负责：

- 选择 provider。
- 构造消息。
- 调用模型。
- 解析输出。
- 校验工具请求。
- 触发工具执行。
- 归档输入输出。

建议事件级模型选择：

- 盘中紧急警报：速度优先，使用低延迟模型。
- 20:30/00:00/周月年复盘：推理质量优先，使用更强模型。
- 普通日志整理：成本优先。

第一版可只实现一个 provider，再逐步接入其他 provider。

## 15. 实现阶段清单

### 阶段 0：项目骨架

- [ ] 初始化 `package.json`。
- [ ] 配置 TypeScript。
- [ ] 配置 `.env.example`。
- [ ] 建立 `src/` 和 `data/` 目录。
- [ ] 增加统一 logger。
- [ ] 增加 `beijing-time` 工具。
- [ ] 增加 `atomic-json` 工具。
- [ ] 建立基础测试框架。

验收：

- [ ] `npm test` 可运行。
- [ ] 可以读取配置。
- [ ] 可以输出当前北京时间。

### 阶段 1：资产迁移与数据 schema

- [ ] 从 OpenClaw workspace 只迁移业务资产，不迁移 OpenClaw 本体。
- [ ] 导入 `stock_database.json`。
- [ ] 建立 `data/memory/rules/`。
- [ ] 建立 `data/memory/MEMORY_INDEX.md`。
- [ ] 定义账户、持仓、交易、记忆写入 schema。
- [ ] 增加数据备份策略。

验收：

- [ ] 原型账户数据可被 `PortfolioStore` 读取。
- [ ] JSON 校验失败时能给出明确错误。
- [ ] 写入前自动备份。

### 阶段 2：行情与历史数据

- [ ] 实现 `TencentQuoteProvider`。
- [ ] 实现批量 quote。
- [ ] 实现 `HistoryProvider`。
- [ ] 实现 MA5、MA10、MA20、60 日区间位置。
- [ ] 增加行情接口失败重试和超时。
- [ ] 增加 fake provider 供测试。

验收：

- [ ] 能拉取持仓股当前价格。
- [ ] 能生成 `history/<code>_history.json`。
- [ ] 测试环境可用 fake quote 复现异动。

### 阶段 3：交易引擎与风控

- [ ] 实现主板代码校验。
- [ ] 实现股数 100 整数倍校验。
- [ ] 实现现金校验。
- [ ] 实现 position lots。
- [ ] 实现 T+1 可卖股数校验。
- [ ] 实现单股 40% 仓位上限。
- [ ] 实现交易流水。
- [ ] 实现账户重新计算。
- [ ] 实现硬止损事件生成。

验收：

- [ ] 买入 `688xxx` 被拒绝。
- [ ] 买入 `300xxx` 被拒绝。
- [ ] 当日买入当日卖出被拒绝。
- [ ] 超现金买入被拒绝。
- [ ] 超 40% 单股仓位被拒绝。
- [ ] 合法交易成功写入流水。

### 阶段 4：记忆系统

- [ ] 实现 `MemoryRegistry`。
- [ ] 实现分类读取。
- [ ] 实现关键词搜索。
- [ ] 实现最近记忆读取。
- [ ] 实现 `MemoryWritePolicy`。
- [ ] 实现 proposal 写入。
- [ ] 实现索引更新。

验收：

- [ ] 能搜索“止损”并返回规则文件。
- [ ] 20:30 复盘可写入长期记忆。
- [ ] 硬规则修改只能进入 proposal。
- [ ] 每次写入有审计记录。

### 阶段 5：小脑调度与雷达

- [ ] 实现北京时间 scheduler。
- [ ] 实现交易时段判断。
- [ ] 实现日内固定闹钟。
- [ ] 实现 00:00 午夜自省。
- [ ] 实现周六 10:00。
- [ ] 实现月末 20:00。
- [ ] 实现 12-31 20:00。
- [ ] 实现 3 秒哨兵。
- [ ] 实现 10 分钟冷却。
- [ ] 实现事件总线。

验收：

- [ ] 使用 fake clock 测试所有闹钟。
- [ ] 月末判断准确。
- [ ] 年末判断准确。
- [ ] 异动只在冷却期外触发。

### 阶段 6：大脑服务与工具运行时

- [ ] 定义 `BrainInput`、`BrainOutput`。
- [ ] 实现一个 provider。
- [ ] 实现 provider 选择配置。
- [ ] 实现 prompt builder。
- [ ] 实现结构化输出解析。
- [ ] 实现工具请求校验。
- [ ] 实现工具运行时。
- [ ] 实现模型输入输出归档。

验收：

- [ ] 08:30 事件能生成晨报。
- [ ] 盘中异动能生成警报分析。
- [ ] 大脑请求交易必须经过 `TradeEngine`。
- [ ] 大脑请求写规则必须进入 proposal。

### 阶段 7：通知与部署

- [ ] 实现 console notifier。
- [ ] 实现 file notifier。
- [ ] 预留 webhook/wechat notifier。
- [ ] 实现 daemon 启动命令。
- [ ] 实现 Windows 本地运行说明。
- [ ] 可选实现 Dockerfile。

验收：

- [ ] 本地命令可启动小脑。
- [ ] 日志可追踪事件。
- [ ] 崩溃后可重启并恢复状态。

## 16. 测试清单

### 单元测试

- [ ] 北京时间转换。
- [ ] 月末/年末判断。
- [ ] 股票代码板块判断。
- [ ] T+1 lots 可卖数量。
- [ ] 交易金额和仓位计算。
- [ ] 记忆写入策略。
- [ ] 技术指标计算。

### 集成测试

- [ ] fake quote 触发 1 分钟急跌。
- [ ] fake quote 触发大盘闪崩。
- [ ] 合法买入后生成 lot。
- [ ] 当日卖出被拒绝。
- [ ] 00:00 自省生成 proposal。
- [ ] 周复盘写入 `weekly_reviews/`。

### 回归测试

- [ ] 不允许大模型直接改 `stock_database.json`。
- [ ] 不允许大模型绕过 `TradeEngine`。
- [ ] 不允许自动削弱红线规则。
- [ ] 不允许没有证据引用的规则变更。

## 17. 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| 行情接口临时失败 | 超时、重试、降级、记录 stale 状态 |
| JSON 文件损坏 | 原子写入、写前备份、schema 校验 |
| 大模型输出不稳定 | 结构化输出、工具校验、失败重试 |
| 自进化误改规则 | proposal 机制、红线不可自动削弱 |
| 时间判断错误 | 所有时间封装为北京时间工具并测试 |
| 轮询过密导致接口风险 | 配置化间隔、批量请求、异常退避 |
| 风控与提示词不一致 | 以代码硬拦截为准，提示词只做说明 |

## 18. 第一版最小可用范围

MVP 建议只做这些：

- 本地 TypeScript 项目。
- JSON 账户数据。
- 腾讯实时 quote。
- 历史 K 线工具。
- TradeEngine 硬拦截。
- 文件夹记忆库。
- 北京时间 scheduler。
- 3 秒 radar。
- 一个大脑 provider。
- console/file 通知。

暂缓：

- 微信通知。
- SQLite。
- 多 provider failover。
- Web UI。
- 真实交易接口。

## 19. 实施优先级

优先级从高到低：

1. 风控硬拦截。
2. 北京时间小脑调度。
3. 账户数据原子写入。
4. 行情/历史数据工程化。
5. 记忆读写策略。
6. 大脑 provider。
7. 通知通道。
8. 部署和守护进程。

这个顺序的原因：先保证底层事实和风险边界可信，再接入大脑。否则大脑越强，越可能把不稳定底座上的错误放大。

## 20. 最终验收定义

系统第一版完成时，应满足：

- 任意交易动作必须经过 `TradeEngine`。
- 任意闹钟必须基于北京时间触发。
- 任意行情判断必须来自 `QuoteProvider` 或 `HistoryProvider`。
- 任意记忆写入必须经过 `MemoryWritePolicy`。
- 任意大脑工具请求必须经过 `ToolRuntime`。
- 大脑不能凭记忆报价、改账、改硬规则。
- 小脑能在无大模型参与时完成盯盘、记账、快照、告警事件生成。
- 大脑只在被小脑或用户触发时工作。
