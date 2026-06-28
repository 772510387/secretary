# Secretary

`secretary` 是一个面向 A 股模拟盘、交易辅助和实盘接入口径演进的独立智能体系统。

它借鉴 OpenClaw 式强智能体交易体验，也吸收 TradingAgents-CN 的研究流程思想；当前设计是：

- 用自研确定性底座承载行情、账户、交易、风控、记忆、小脑调度和审计。
- 用 OpenAI/Gemini/DashScope Qwen 等模型承载研究、复盘、解释、标的排序、交易意图和自然语言交互。
- 将 TradingAgents-CN 作为可选深度研究顾问，研究结果可进入 secretary 的执行提案和审计链路。

核心原则：

> 凡是事实、账本、回执和规则，必须可审计；凡是判断、策略、取舍和表达，交给强 AI。

## 快速启动（默认走飞书）

默认对话接入是**飞书双向机器人**（官方长连接，无封号风险、无需公网 IP）：

```powershell
npm install            # 安装依赖（含飞书 SDK，无需另装）
npm start              # 启动全天候值守：飞书对话 + 哨兵 + 闹钟矩阵 + 链式巡航
```

前置：在 `.env` 配好 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_ALLOWED_USERS`，
并用真实大脑 `BRAIN_PROVIDER=dashscope`（+ `DASHSCOPE_API_KEY`）。看到
`✅ 飞书机器人已通过长连接启动` 后，在飞书里私聊该应用即可对话。完整步骤见
`docs/ops/feishu-bot.md`。如果只想启动聊天入口，可单独运行 `npm run feishu:bot`。

其它入口（可选）：`npm run wechat:bot`（个人微信，有 ToS 封号风险）、
`npm run ask -- "..."`（命令行单问）。

值守进程（按需常驻，外部推送走飞书 `FEISHU_NOTIFY=1`）：
- `npm run sentinel:dev -- --live --wake-brain` —— 盘中 3 秒级盯盘；异动(红线)时唤醒大脑出 AI 研判再报警（平时零 token）。
- `npm run cerebellum:dev` —— 全天闹钟矩阵到点用真实数据跑 SOP → 大脑研判 → 推送（`--list` 看节点，`--fire <节点>` 手动验证）。

## 当前状态

当前项目已经从 T001-T014 架构骨架推进到 U1-U10 基础能力完成或评估阶段：

- 已沉淀需求源：`docs/requirements`
- 已沉淀实现方案：`docs/requirement/stock-agent-implementation-plan.md`
- 已创建分层目录和每个实现点 README
- 已实现 T001 ConfigLoader，`npm run doctor` 会读取并校验配置
- 已实现 T002 JsonStore 和 AtomicFileWriter，支持 schema 校验、原子写入和写入前备份
- 已实现 T003 基础数据 schema，覆盖账户、持仓、交易流水和审计事件
- 已实现 T004 初始化模拟账户，当前 `memory/portfolio` 已有 2 万元 paper 账户
- 已实现 T005 Portfolio 计算，覆盖现金、持仓估值、成本、浮盈浮亏和 T+1 可卖数量
- 已实现 T006 PaperBroker，支持模拟买卖、拒单、交易流水和 `intent_id` 防重复
- 已实现 T007 PolicyEngine，覆盖主板过滤、100 股买入、T+1、现金和持仓基础规则
- 已实现 T008 RiskEngine，覆盖单股 40%、8% 止损、单日亏损、禁买和熔断
- 已实现 T009 TencentQuoteProvider，支持腾讯实时行情解析、单只/批量查询和 mock 测试
- 已实现 T010 MarketSentinel 单次检查，覆盖行情急涨急跌、持仓止损和告警冷却
- 已实现 T011 Scheduler，覆盖北京时间、固定闹钟、盘中循环、任务防重入和优雅停止
- 已实现 T012 BrainProvider 抽象和 MockBrainProvider，覆盖结构化输出校验和真实 provider 缺 key 错误
- 已实现 T013 报告生成，使用 MockBrainProvider 生成盘前、午间、收盘和每日自省报告并写入 `memory/reports`
- 已实现 T014 TradingAgents-CN Research Adapter 最小版本，输出 `ResearchReport`，支持超时降级和 `memory/research` 写入
- 已完成 U1 历史行情和技术指标、U2 记忆写入策略、U3 记忆检索和索引、U4 ToolRuntime 工具请求校验、U5 小脑固定闹钟上下文包、U6 本地通知通道
- 已完成 U7 DashScope Qwen provider、R8-1 OpenAIProvider、U8 TradingAgents-CN 子进程 runner fake subprocess 版、U9 ManualConfirmBroker paper-only 门禁
- 已完成 U10 实盘预备评估和 R9 实盘安全底座，包含 LiveTradingGate、账户 allowlist 和 kill switch；真实 broker、自动化执行和对账能力按后续阶段接入

当前仍未完成的重点能力：

- 自选股雷达、指数雷达和放量雷达。
- Webhook/API 入口、真实微信或外部 webhook 通知。
- 只读 broker、fake live broker contract、真实 broker adapter、对账系统和人工审批持久化。
- 实盘自动化执行口径：模型强判断 -> 执行提案 -> 风控/权限/适配器 -> 回执/对账/审计。

## 目录地图

- `src/`：未来 TypeScript 源码。
- `src/domain/`：领域规则，禁止依赖外部 SDK 细节。
- `src/infrastructure/`：文件系统、行情供应商、券商适配、调度器等外部适配。
- `src/interfaces/`：CLI、API、Webhook 等入口。
- `src/runtime/`：组合根，负责装配配置、依赖和启动任务。
- `memory/`：可审计长期记忆和运行沉淀。
- `data/`：schema、种子数据、缓存。
- `config/`：非密钥配置模板。
- `scripts/`：开发、运维、AI 辅助脚本。
- `tests/`：单元、集成、回归测试。
- `docs/architecture/`：架构设计。
- `docs/ai/`：vibecoding 辅助上下文、提示词、检查清单和项目技能。

## 执行边界

运行模式由配置决定：模拟盘、人工确认、只读 broker、fake live broker 和真实 broker 需要清晰区分。

模型可以产生强交易判断、`TradeIntent`、执行提案和操作理由；发单和账户变更必须经过可审计执行链路：

1. `PolicyEngine`
2. `RiskEngine`
3. `LiveTradingGate`
4. `OrderManager`
5. `BrokerAdapter`
6. `AuditLog`
7. 必要时的人工确认

## 推荐阅读顺序

1. `AGENTS.md`
2. `docs/architecture/README.md`
3. `docs/architecture/module-map.md`
4. `docs/requirement/stock-agent-implementation-plan.md`
5. 目标模块下的 `README.md`
