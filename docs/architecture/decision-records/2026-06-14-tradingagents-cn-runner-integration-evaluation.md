# TradingAgents-CN Runner 接入评估

## 背景

当前 `secretary` 已有 `TradingAgentsCnAdapter` 最小版本，可以通过注入 runner 把外部研究输出转换为 `ResearchReport`。P5-3 只评估真实 TradingAgents-CN runner 的接入方式，不复制 TradingAgents-CN 的专有 `app/` 或 `frontend/`，不接 broker，不启动真实常驻服务。

调研日期：2026-06-14。

外部约束：

- TradingAgents-CN README 说明项目用于股票分析学习与研究，不提供实盘交易指令。
- TradingAgents-CN 采用混合许可证：除 `app/` 和 `frontend/` 外的部分为 Apache 2.0；`app/` 和 `frontend/` 是专有组件，需要按其许可边界处理。

参考：

- https://github.com/hsliuping/TradingAgents-CN/blob/main/README.md
- https://github.com/hsliuping/TradingAgents-CN/blob/main/LICENSE
- https://github.com/hsliuping/TradingAgents-CN/blob/main/LICENSING.md

## 决策

首个真实接入方案建议使用外部子进程 runner：

```text
secretary -> TradingAgentsCnSubprocessRunner -> 外部 TradingAgents-CN 安装目录/脚本 -> stdout JSON -> TradingAgentsCnAdapter -> ResearchReport
```

不优先使用 HTTP 服务或本地包调用。

核心边界：

- TradingAgents-CN 作为外部研究进程，不作为 `secretary` 的业务模块被复制进仓库。
- 不复制、不改写、不派生 TradingAgents-CN 的 `app/` 或 `frontend/`。
- runner 不接收 broker、账户、订单、实盘密钥或可执行交易工具。
- 外部输出只能进入 `TradingAgentsCnAdapter`，再转换为 `ResearchReport`。
- 外部输出里的 `orders`、`execution`、`broker`、`account`、`positions` 等字段必须被忽略或标记为 rejected metadata，不得进入订单链路。
- 超时、异常、schema 失败时只允许返回 `degraded=true` 的降级研究报告，或在 `fallbackOnError=false` 时抛出 `ResearchProviderError`。

## 替代方案评估

### 子进程 runner

优点：

- 隔离清晰，TradingAgents-CN 仍是外部工具。
- 不需要引入常驻服务、端口、安全鉴权和服务发现。
- 超时后可以终止外部任务，避免研究流程卡住 scheduler。
- 适合当前阶段的低频 mock/手动研究任务。
- 可用 fake subprocess 覆盖 stdout、stderr、超时、非零退出码和坏 JSON。

缺点：

- 每次启动有进程开销。
- 需要处理 Windows 和类 Unix 的进程树终止差异。
- 外部 Python 环境、依赖和工作目录需要额外配置。

结论：第一阶段采用。

### HTTP 服务

优点：

- 适合未来常驻研究服务、并发队列、进度回调和远程部署。
- 可以独立扩缩容，避免每次冷启动。

缺点：

- 需要新增认证、端口、服务健康检查、日志脱敏、重试、服务发现和部署说明。
- 常驻服务更容易形成隐式状态，失败恢复复杂。
- P5-3 阶段会扩大运维面。

结论：暂不采用。只有在子进程启动成本成为明确瓶颈，且已有队列、鉴权和运维方案后再评估。

### 本地包调用

优点：

- 理论上调用延迟最低。
- 调试时可以直接访问 Python API。

缺点：

- Node/TypeScript 与 Python 包边界耦合过重。
- import side effect、全局配置和依赖冲突难隔离。
- 超时后很难可靠中断深层 Python/LLM/网络调用。
- 容易误把外部研究框架变成项目内业务依赖。

结论：第一阶段拒绝。

## 输入协议

runner 输入必须是单个 JSON 对象，通过 stdin、临时请求文件或命令行指定文件传入。推荐结构：

```json
{
  "protocolVersion": "secretary.tradingagents-cn.runner.v1",
  "requestId": "research-run-001",
  "task": {
    "taskId": "task-001",
    "symbol": "000636",
    "market": "CN_A",
    "question": "生成一份模拟研究报告",
    "asOf": "2026-06-14T09:30:00.000+08:00"
  },
  "options": {
    "timeoutMs": 30000,
    "locale": "zh-CN",
    "mode": "paper_research",
    "allowNetwork": false,
    "allowBroker": false,
    "allowOrders": false
  }
}
```

规则：

- `allowBroker` 和 `allowOrders` 必须固定为 `false`。
- API key 只能来自外部进程自己的环境变量或本机密钥管理，不写入请求 JSON。
- `secretary` 只传研究任务、只读上下文和输出要求，不传账户文件、broker 配置或交易凭证。
- 默认 `allowNetwork=false`；真实网络研究必须另设显式开关和手动 smoke test。

## 输出协议

外部进程 stdout 必须输出一个严格 JSON 对象，或输出一行带前缀的最终 JSON：

```text
SECRETARY_RESULT_JSON:{"protocolVersion":"secretary.tradingagents-cn.runner.v1","requestId":"research-run-001","status":"ok","report":{}}
```

推荐 JSON 结构：

```json
{
  "protocolVersion": "secretary.tradingagents-cn.runner.v1",
  "requestId": "research-run-001",
  "status": "ok",
  "provider": "tradingagents-cn",
  "durationMs": 1200,
  "report": {
    "title": "000636 模拟研究报告",
    "summary": "研究摘要",
    "conclusion": "仅供人工复核的研究结论",
    "confidence": 0.6,
    "findings": [],
    "risks": [],
    "sources": [],
    "recommendations": []
  },
  "metadata": {
    "modelProvider": "mock",
    "degraded": false
  }
}
```

输出规则：

- stdout 的最终结果必须能被 `TradingAgentsCnAdapter` 转换并通过 `ResearchReport` schema。
- stderr 只允许记录脱敏进度和错误摘要，不作为报告正文。
- 如果输出包含交易执行字段，adapter 必须忽略，并在 metadata 里记录被忽略字段名。
- 坏 JSON、空输出、schema 失败、非零退出码都按 runner 失败处理。

## 超时和终止

默认超时沿用 `TradingAgentsCnAdapter` 的 `30000ms`，真实长研究可在调用侧显式调高。

终止策略：

1. `AbortController` 触发取消。
2. 停止读取后续 stdout/stderr，并标记 runner timeout。
3. 先请求子进程温和退出。
4. 宽限期后终止整个进程树。
5. 记录 `timeout`、`durationMs`、`requestId`、`taskId`、`symbol` 和 `degraded=true`。

平台注意：

- Windows 需要单独的进程树终止 helper，避免只杀父进程而留下 Python 子进程。
- 类 Unix 可使用进程组终止。
- 测试使用 fake process 或短命令模拟超时，不依赖真实 TradingAgents-CN、真实 LLM 或网络。

## 日志脱敏

允许记录：

- `requestId`
- `taskId`
- `symbol`
- `provider`
- `durationMs`
- `exitCode`
- `status`
- `degraded`
- 被忽略的危险字段名

不得记录：

- API key、token、cookie、broker 凭证。
- 账户号、完整持仓、真实下单参数。
- 完整 prompt、完整研究正文、原始新闻大段正文。
- 外部进程的完整环境变量。

如果需要 debug 原始输出，只能在显式 debug 开关下写入本地 debug cache，并要求脱敏、TTL 和大小限制；不得进入领域对象。

## 失败降级

失败映射：

- 启动失败：`ResearchProviderError(code="process_start_failed")`。
- 非零退出：`ResearchProviderError(code="process_exit_failed")`。
- 超时：`ResearchProviderError(code="timeout")`。
- 坏 JSON：`ResearchProviderError(code="invalid_output")`。
- schema 失败：`ResearchProviderError(code="schema_validation_failed")`。

`fallbackOnError=true` 时：

- 返回 `degraded=true` 的 `ResearchReport`。
- `tradeIntentDrafts` 必须为空。
- `proposalDrafts` 必须为空。
- 标记需要人工复核。
- 审计只记录失败元数据，不记录完整正文。

`fallbackOnError=false` 时：

- 抛出 `ResearchProviderError`。
- 不写入成功报告。

## 测试要求

后续实现真实子进程 runner 时必须补集成测试：

- valid stdout JSON -> `ResearchReport`。
- `SECRETARY_RESULT_JSON:` 前缀输出 -> `ResearchReport`。
- stderr 脱敏，不把 secret-like 内容写入审计。
- 非零退出码 -> 降级或抛错。
- 超时 -> 终止 fake 进程并降级。
- 坏 JSON -> 不写成功报告。
- 输出含 `orders`、`execution`、`broker` 字段 -> 忽略并记录 metadata。
- 不导入、不复制 TradingAgents-CN `app/` 或 `frontend/`。
- 不调用真实 LLM、不联网、不接 broker。

## 后续动作

1. 新增 `TradingAgentsCnSubprocessRunner` 设计接口，但默认仍使用 mock runner。
2. 把 runner 命令、工作目录、超时、是否允许网络放入配置 schema。
3. 增加 fake subprocess 集成测试覆盖成功、失败和超时。
4. 增加手动 smoke test，默认跳过，需要显式环境变量启用。
5. 只有在子进程方案验证稳定后，再评估 HTTP 常驻服务。

## 不做事项

- 不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。
- 不把 TradingAgents-CN 作为本项目内嵌业务代码。
- 不接 PaperBroker、ManualConfirmBroker 或真实 broker。
- 不允许外部 runner 写账户、订单、规则文件或持仓。
- 不在 P5-3 写 API key 或真实服务配置。
