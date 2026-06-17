# Post-T014 交互推进清单

生成日期：2026-06-13

本清单用于 T014 完成后的继续推进。目标不是马上进入实盘，而是把模拟盘、研究、报告、审计和手动操作闭环打稳。

## 0. 当前基线

截至本清单生成时，项目基线为：

- T001-T014 已完成。
- `npm run doctor` 通过，默认 `LIVE_TRADING=false`、`BROKER_PROVIDER=paper`、`BRAIN_PROVIDER=mock`。
- `npm run typecheck` 通过。
- `npm test` 通过，真实网络 smoke test 默认跳过。
- Git 当前已初始化，主分支为 `main`。
- `.env`、`.codex/`、运行态账户 JSON、运行态报告 JSON、研究报告 JSON 不应进入仓库。

## 1. 每轮交互固定格式

每次只给 AI 一个明确任务，不要一次要求“把剩下都做完”。

推荐格式：

```text
请按 AGENTS.md 和 docs/ai/context-map.md 加载上下文。
执行 post-T014 清单中的 <任务编号>。
完成后补测试，更新相关 README，并运行 npm run doctor、npm run typecheck、npm test 中适用的验证。
最后按 docs/ai/checklists/change-checklist.md 说明完成了什么、验证了什么、还剩什么风险。
```

每轮完成后人工确认三件事：

- 是否仍然默认模拟盘。
- 是否新增了可追踪测试。
- 是否有审计线索或明确说明本轮不涉及写入。

## 2. 全局禁止项

在完成模拟盘闭环稳定前，不做以下事情：

- 不接真实 broker。
- 不实现自动实盘买入。
- 不把 LLM 或研究系统输出直接接入 `PaperBroker` 或未来 broker。
- 不把 API key、券商账号、真实交易参数写入仓库。
- 不复制 TradingAgents-CN 的专有 `app/` 或 `frontend/`。
- 不把本地 `.env`、运行态账户文件、运行态报告文件提交到 Git。

## 3. P0 文档和状态校准

### P0-1 修正 next-action-checklist 当前状态

目标：

- 修正 `docs/requirement/next-action-checklist.md` 顶部的旧状态。
- 明确 T001-T014 已完成。
- 把“你现在应该做什么”从 T001 起步改为 post-T014 后续推进。
- 保留 T015-T019 为“模拟盘稳定后再做”。

目标文件：

- `docs/requirement/next-action-checklist.md`
- `docs/requirement/README.md`

验收：

- 文档不再同时说“没有真实代码实现”和“T014 已完成”。
- 后续 agent 能直接知道下一步从 P0/P1 开始。
- 不改业务代码。

交给 AI 的提示词：

```text
请执行 docs/requirement/post-t014-interaction-checklist.md 的 P0-1。
只修正文档状态，不改业务代码。
重点修正 next-action-checklist.md 顶部和底部的过期说明。
完成后说明无需运行业务测试或运行 npm run typecheck 作为轻量验证。
```

### P0-2 Git 发布前检查

目标：

- 确认 `.gitignore` 仍然排除本机和运行态文件。
- 确认 `git status --short --branch` 干净。
- 确认远程地址正确。
- 确认没有密钥文本进入仓库。

建议命令：

```powershell
git status --short --branch
git remote -v
git ls-files .env .codex memory/portfolio memory/reports memory/research
rg -n "OPENAI_API_KEY=.+|GEMINI_API_KEY=.+|DASHSCOPE_API_KEY=.+|TUSHARE_TOKEN=.+|BROKER_ACCOUNT_ID=.+" . -g "!node_modules" -g "!package-lock.json"
```

验收：

- `.env` 不在 `git ls-files` 输出中。
- `.codex/` 不在 `git ls-files` 输出中。
- 运行态 JSON 不在 `git ls-files` 输出中。
- 远程仓库指向预期 GitHub 仓库。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P0-2 Git 发布前检查。
只运行检查命令，不修改文件。
把发现的问题按风险排序说明。
```

## 4. P1 研究记忆审计补强

### P1-1 ResearchMemoryStore 写入审计日志

目标：

- 研究报告写入 `memory/research` 时追加审计事件。
- 审计事件只记录元数据，不记录完整研究正文。
- 写入路径仍然使用原子写入和备份策略。

建议范围：

- `src/infrastructure/storage/research-memory.ts`
- `src/domain/audit`
- `tests/integration/trading-agents-cn-adapter.test.ts` 或新增集成测试
- `src/infrastructure/storage/README.md`
- `memory/research/README.md`

审计 metadata 建议包含：

- `reportId`
- `taskId`
- `provider`
- `symbol`
- `tradingDate`
- `degraded`
- `tradeIntentDraftCount`
- `requiresHumanReview`
- `filePath`
- `backupPath`，如有

禁止：

- 不记录完整 `summary`。
- 不记录完整 `findings`。
- 不记录完整 `tradeIntentDrafts.rationale`。
- 不触发 broker。

验收：

- 写入研究报告会追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 重复写入产生 backup，并在审计 metadata 中可见。
- schema 校验失败时不写研究报告，也不写成功审计。
- 测试使用临时目录。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P1-1。
给 ResearchMemoryStore.writeReport 补审计日志，审计只记录元数据，不记录完整研究正文。
补集成测试，更新 storage 和 memory/research README。
运行 npm run typecheck 和 npm test。
完成后按 change-checklist 汇报。
```

### P1-2 统一审计日志辅助函数

目标：

- 如果 P1-1 发现多个模块重复手写 JSONL 审计逻辑，则抽出最小审计写入 helper。
- 不做大型 logging 框架。

建议范围：

- `src/infrastructure/logging` 或 `src/infrastructure/storage`
- 现有 paper account / paper broker / research memory 的写审计调用
- 对应测试

验收：

- 不改变审计事件 schema。
- 原有 paper account 和 paper broker 测试继续通过。
- ResearchMemoryStore 使用同一审计写入路径。

交给 AI 的提示词：

```text
请评估是否需要执行 post-T014 清单 P1-2。
如果现有审计写入重复明显，就抽出最小 helper；如果重复不明显，只说明暂不抽象。
不得引入大型日志框架。
运行 npm run typecheck 和 npm test。
```

## 5. P2 手动研究入口

### P2-1 runResearchOnce 应用用例

目标：

- 增加一个应用层用例，手动运行一次研究。
- 输入 `ResearchTask` 或基础参数。
- 调用注入的 research adapter。
- 可选写入 `ResearchMemoryStore`。
- 返回结构化结果。

建议范围：

- `src/app/run-research-once.ts`
- `src/app/index.ts`
- `tests/integration` 或 `tests/unit`
- `src/app/README.md`

边界：

- 不请求真实 TradingAgents-CN。
- 默认 runner 使用 mock。
- 不调用 broker。
- 不写账户。
- 不读取 `.env` 密钥。

验收：

- 可以通过 mock runner 生成 `ResearchReport`。
- 可以选择只返回不落盘。
- 可以选择落盘并产生审计，前提是 P1-1 已完成。
- 外部执行字段仍被隔离。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P2-1。
实现 runResearchOnce 应用用例，默认使用注入的 mock runner，不接真实外部系统。
支持只返回报告和写入 memory/research 两种模式。
不接 broker，不写账户。
补测试并更新 app README。
```

### P2-2 开发脚本 research-once

目标：

- 增加一个开发脚本，便于命令行手动生成一份 mock 研究报告。
- 默认 mock，不联网。

建议命令形态：

```powershell
npm run research:once -- --symbol 000636 --market SZSE --date 2026-06-13 --objective "生成一次安全研究报告"
```

建议范围：

- `scripts/dev/research-once.ts`
- `package.json`
- `scripts/dev/README.md`
- 测试可覆盖参数解析或用例层，不强求真实执行脚本

验收：

- 缺参数时报清楚错误。
- 默认不联网。
- 默认不下单。
- 输出报告路径或 degraded 状态。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P2-2。
增加 npm run research:once 开发脚本，默认使用 mock runner，生成并写入一份研究报告。
不接真实 TradingAgents-CN，不接 broker。
补参数解析测试或说明测试边界，更新 scripts/dev README。
```

## 6. P3 模拟盘闭环集成

### P3-1 单次闭环集成测试

目标：

打通一次安全的模拟闭环：

```text
mock account/positions
  -> mock quote
  -> MarketSentinel
  -> ResearchTask
  -> TradingAgentsCnAdapter mock runner
  -> ResearchMemoryStore
  -> Report generation
  -> Audit log
```

建议范围：

- 新增 `tests/integration/paper-research-loop.test.ts`
- 需要时新增 `src/app` 组合函数
- 更新 `tests/integration/README.md`

边界：

- 不联网。
- 不调用真实 LLM。
- 不调用 broker。
- 不改变真实 `memory/`，测试必须使用临时目录。

验收：

- 哨兵事件可以触发研究任务构造。
- 研究报告写入临时 memory。
- 报告建议和研究草案都不可执行。
- 审计日志可追踪关键写入。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P3-1。
新增一次 mock 的 paper research loop 集成测试。
必须使用临时目录，不联网，不调用真实 LLM，不调用 broker。
验证从哨兵事件到研究报告、报告生成和审计日志的最小闭环。
运行 npm run typecheck 和 npm test。
```

### P3-2 盘中 runner 组合验证

目标：

- 在不启动真实常驻进程的前提下，验证 scheduler runner 可以调起单次闭环回调。
- 仍然使用 mock 数据。

建议范围：

- `src/runtime`
- `tests/integration/scheduler.test.ts` 或新增测试
- `src/runtime/README.md`

验收：

- 交易时段内会触发一次回调。
- 非交易时段降频或不触发高频逻辑。
- 同一 job 不重入。
- 回调失败不导致进程失控。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P3-2。
验证 scheduler runner 可以调起一次 mock 闭环回调。
不要启动真实常驻进程，不联网，不接 broker。
补集成测试并更新 runtime README。
```

## 7. P4 手动确认与交易前置，不进入实盘

### P4-1 TradeIntentDraft 到人工确认提案

目标：

- 把研究报告里的 `TradeIntentDraft` 转成待人工确认提案。
- 仍然不进入 `PaperBroker`。
- 为 T015 `ManualConfirmBroker` 做前置模型。

建议范围：

- `src/domain/memory` 或 `src/domain/trading`
- `memory/proposals/README.md`
- `tests/unit` 或 `tests/integration`

验收：

- 提案状态明确：`pending_review`、`approved`、`rejected` 等。
- 默认不可执行。
- 没有人工确认时不能进入订单链路。
- 写入提案有审计。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P4-1。
把 ResearchReport.tradeIntentDrafts 转成待人工确认提案模型。
不要接 PaperBroker，不要下单。
补测试，更新 memory/proposals README。
```

### P4-2 ManualConfirmBroker 设计文档

目标：

- 先写设计，不实现真实 broker。
- 明确人工确认如何进入 paper broker 或未来 live broker。

建议范围：

- `docs/architecture/decision-records`
- `src/infrastructure/broker/README.md`
- `docs/ops/live-trading-readiness.md`

验收：

- 明确人工确认前后状态。
- 明确仍然经过 PolicyEngine、RiskEngine、AuditLog。
- 明确 `LIVE_TRADING=true` 不足以发实盘单。

交给 AI 的提示词：

```text
请执行 post-T014 清单 P4-2。
只写 ManualConfirmBroker 设计文档，不实现真实 broker。
重点说明人工确认、风控、审计和 LIVE_TRADING 边界。
```

## 8. P5 可选外部能力

这些任务只有在 P1-P3 稳定后再做。

### P5-1 真实 Tencent quote smoke 手动验证

目标：

- 手动跑真实网络行情 smoke test。
- 不把网络测试设为默认必跑。

命令：

```powershell
$env:TENCENT_QUOTE_NETWORK='1'
npm test -- tests/integration/tencent-quote-provider.test.ts
Remove-Item Env:TENCENT_QUOTE_NETWORK
```

验收：

- 网络可用时通过。
- 网络不可用时只记录现象，不改默认测试策略。

### P5-2 真实 BrainProvider 接入评估

目标：

- 先评估 OpenAI/Gemini/DashScope Qwen 哪个 provider 最适合接入。
- 不在评估任务中写 API key。
- 不让模型拥有工具执行权限。

验收：

- 形成 provider 接入设计。
- 明确输出 schema 校验。
- 明确错误、限流、超时、费用控制。

### P5-3 真实 TradingAgents-CN runner 接入评估

目标：

- 评估用子进程、HTTP 服务还是本地包调用接入。
- 不复制其专有 `app/` 或 `frontend/`。
- 明确超时后如何终止外部任务。

验收：

- 形成 ADR。
- 明确输入输出协议。
- 明确日志脱敏和失败降级。

## 9. 每轮完成后的标准检查

每轮任务完成后，都让 AI 执行：

```text
请按 docs/ai/checklists/change-checklist.md 检查本次改动。
说明完成了什么、验证了什么、还剩什么风险。
```

同时人工检查：

- `git status --short --branch`
- 是否只改了目标范围。
- 是否更新了目标模块 README。
- 是否新增或更新测试。
- 是否仍然 `LIVE_TRADING=false` 默认。
- 是否没有新增真实 broker 默认路径。

## 10. 推荐执行顺序

最推荐顺序：

1. P0-1 修正文档状态。
2. P0-2 Git 发布前检查。
3. P1-1 ResearchMemoryStore 写入审计日志。
4. P2-1 `runResearchOnce` 应用用例。
5. P2-2 `research:once` 开发脚本。
6. P3-1 单次闭环集成测试。
7. P3-2 盘中 runner 组合验证。
8. P4-1 TradeIntentDraft 到人工确认提案。
9. P4-2 ManualConfirmBroker 设计文档。
10. P5 外部能力评估。

做到第 7 步后，再判断是否进入 T015。不要在第 7 步之前实现真实 broker。
