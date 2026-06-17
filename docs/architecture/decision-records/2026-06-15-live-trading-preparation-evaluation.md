# 实盘预备评估与暂缓自动实盘

## 背景

U1-U9 已经补齐行情、记忆、工具边界、小脑上下文、通知、真实 BrainProvider、TradingAgents-CN 子进程 runner 和 paper-only `ManualConfirmBroker`。

当前项目仍然处于模拟盘和辅助决策阶段。U10 只评估实盘预备任务，不实现真实 broker，不写券商账号，不下单。

调研日期：2026-06-15。

参考资料：

- 迅投 XtQuant 文档：`https://dict.thinktrader.net/nativeApi/start_now.html`
- 迅投 Xttrade 交易模块：`https://dict.thinktrader.net/nativeApi/xttrader.html`
- 山西证券 PTrade 量化交易系统：`https://www.i618.com.cn/main/companybusi/wealth/quantitativetrading/ptrade/index.shtml`
- 恒生客户服务平台 PTrade 文档入口：`https://www.hs.net/openplat-doc/proFDoc`

## 决策

暂缓任何自动实盘实现。

`LIVE_TRADING=true` 仍然只能表示“允许进入实盘预备检查”，不能表示“允许发真实委托”。未来实盘委托至少必须同时满足：

- `LIVE_TRADING=true`。
- `TRADING_MODE=live`。
- broker provider 显式选择真实 broker。
- 账户在本地 allowlist。
- 真实 broker 凭证只来自环境变量或本机密钥管理。
- 该笔交易有完整人工确认记录。
- `PolicyEngine` 通过。
- `RiskEngine` 通过。
- 应急停机未触发。
- 熔断和禁买未触发。
- 下单前审计写入成功。
- broker 委托结果可查询。
- 成交结果可查询。
- 对账通过或进入人工异常处理。

缺少任一条件时，系统必须拒绝，并写审计，不得尝试真实下单。

## U10-1 真实 Broker 抽象补强

状态更新：截至 2026-06-16，R10 已定义 `LiveBrokerAdapter` contract，并实现 `FakeLiveBrokerAdapter`、`FakeReadOnlyBroker` 和 `QmtFakeSubprocessBridge` fake 协议测试版。当前仍不实现真实 broker，不写券商账号，不提交真实委托。

必须具备的能力：

- `getAccountSnapshot()`：重新查询真实账户资金。
- `getPositions()`：重新查询真实持仓。
- `getSellableQuantity(symbol)`：重新查询真实可卖数量。
- `submitOrder(intent, preflight)`：提交限价委托，只接受已通过 gate 的确定性 `TradeIntent`。
- `cancelOrder(orderRef)`：撤单。
- `queryOrder(orderRef)`：查询委托状态。
- `queryExecutions(orderRef)`：查询成交回报。
- `healthCheck()`：确认客户端、会话、柜台和账号状态。

接口约束：

- 真实 broker 不接收 `ResearchReport`、LLM 输出或 pending proposal。
- 所有提交必须带 `intentId`、`proposalId`、`approvalId`、`policyAuditId`、`riskAuditId`。
- 所有 live 方法默认失败关闭，必须通过 `LiveTradingGate`。
- 下单只允许限价委托，禁止市价单、算法单、融资融券扩展单和篮子单，直到另有 ADR。
- 所有返回值必须映射成统一 `Order`、`ExecutionReport`、`ReconciliationResult` 或明确错误。

## U10-2 QMT / PTrade 调研和 ADR 结论

### QMT / XtQuant

公开文档显示，XtQuant 是基于 MiniQMT 的 Python 策略框架，运行前需要启动 MiniQMT 客户端；Xtdata 提供行情，Xttrader 提供交易 API，并包含报单、撤单、资产、委托、成交、持仓查询以及回调推送能力。

适配倾向：

- 第一候选：外部 Python 子进程桥接。
- 原因：当前项目已经有 TradingAgents-CN 子进程 runner 模式，适合隔离 Python SDK、客户端会话和超时终止。
- 不把 XtQuant SDK 直接作为 TypeScript 依赖。
- 不把券商客户端路径、资金账号或密码写入仓库。

主要风险：

- MiniQMT 客户端生命周期、登录态和断线重连需要独立守护。
- Windows 进程树终止和回调线程要实测。
- 委托回报和查询回报可能存在延迟，必须靠对账闭环确认最终状态。
- 真实账号权限、券商版本和接口返回字段可能因券商而异。

### PTrade

公开券商页面把 PTrade 定位为集策略投研、回测、交易、日内回转、算法交易和异常交易风控于一体的量化交易系统，并说明开通权限需通过券商流程。恒生也提供 PTrade 文档入口。

适配倾向：

- 第二候选：先作为独立托管交易平台评估，不作为本项目首个 live delegate。
- 原因：PTrade 常见形态更偏券商端策略环境，不一定适合本地 `secretary -> broker adapter` 的同步调用模型。
- 如果未来采用，应优先设计“上传只读策略 / 人工运行 / 回传对账文件”的隔离方案，而不是让 `secretary` 直接持有 PTrade 实盘执行能力。

主要风险：

- 各券商 PTrade 版本、Python 版本、支持库和权限差异明显。
- 托管环境可能不允许联网或安装第三方库。
- 把策略部署到券商环境会带来代码发布、回滚、密钥、审计和对账的新边界。

R10-4 更新结论：

- PTrade 更适合作为券商侧托管环境或独立量化平台评估，不适合作为当前首个本地同步调用的 `LiveBrokerAdapter`。
- 若未来使用 PTrade，应优先采用隔离方案：`secretary` 生成只读任务、人工审批材料或对账输入，PTrade 环境独立执行，结果通过日志/报表/对账文件回传。
- PTrade 权限必须最小化，区分只读、模拟、撤单、实盘委托和策略发布权限；不得把生产权限默认授予开发环境。
- PTrade 运行环境必须和本项目本地运行态隔离，明确券商侧 Python 版本、依赖安装限制、网络限制、交易日历、运行窗口和发布回滚流程。
- 日志导出必须满足审计和对账需要，至少能关联 `proposalId`、`approvalId`、`intentId`、broker request id、委托编号、成交编号、状态变更时间和失败原因。
- 对账必须以 PTrade 导出结果或券商对账单为准，不能只相信本地推测状态；对账失败进入人工处理和 readOnly/cancelOnly 降级。
- 当前不实现 `PTradeBroker`，不写券商账号，不下单。

### 结论

第一阶段不实现 QMT 或 PTrade。

如果未来要做最小 live smoke，优先评估 QMT 外部子进程桥接，因为它更符合当前本地组合根和子进程隔离模式。PTrade 作为第二候选，只在确认券商环境、权限、文档和对账机制后再评估。

## U10-3 实盘熔断和应急停机

状态更新：截至 2026-06-16，R9 已实现非交易性的 `LiveTradingGate`、账户 allowlist 和全局/账户/标的 kill switch 状态持久化；R10 已实现 fake/read-only broker contract 和 QMT fake 子进程协议。仍未实现真实 broker、真实只读 smoke、对账系统和人工审批持久化。

未来必须保留独立于 `RiskEngine` 的 `LiveTradingGate`，至少包含：

- `globalKillSwitch`：全局应急停机。
- `accountKillSwitch`：账户级停机。
- `symbolKillSwitch`：标的级停机。
- `noBuy`：禁止新增买入。
- `cancelOnly`：只允许撤单，不允许新单。
- `readOnly`：只允许查询。
- `dailyOrderCountLimit`：单日委托次数限制。
- `dailyNotionalLimit`：单日成交额或委托额限制。
- `maxOrderNotional`：单笔金额上限。
- `maxPositionRatio`：单股仓位上限。

应急停机必须满足：

- 可以通过本地只读配置或本地状态文件快速切换。
- 切换必须写审计。
- kill switch 触发后，后续 live submit 必须失败关闭。
- kill switch 触发不自动撤单；撤单需要单独人工确认，除非未来另有 ADR。

## U10-4 对账系统

未来必须新增 `Reconciliation` 能力，至少覆盖：

- 订单：本地 intent/order 与 broker 委托状态一致。
- 成交：broker 成交与本地 trade/execution 一致。
- 资金：现金、冻结、可用资金与 broker 查询一致。
- 持仓：数量、可卖、冻结、成本价与 broker 查询一致。
- 异常：缺失委托、重复委托、部分成交、撤单中、废单、未知状态。

对账策略：

- 下单后必须查询委托。
- 成交后必须查询成交。
- 每个交易日收盘后必须跑全量对账。
- 对账失败必须进入 `critical` 通知和人工处理，不得自动继续下单。
- 对账日志只记录元数据和差异摘要，不记录凭证或完整敏感账户资料。

## U10-5 最小人工确认 Smoke 设计

未来最小 live smoke 必须是人工、小额、单笔、限价、可撤回的验证，不允许自动买入。

建议顺序：

1. 只读 smoke：连接 broker，只查询账号状态、资金、持仓、委托、成交，不提交委托。
2. 只撤单 smoke：如果券商支持模拟或测试环境，验证撤单接口；真实账户不得创建测试委托再自动撤。
3. 人工小额卖出 smoke：仅限已有小额持仓，数量 100 股，限价偏保守，人工确认两次。
4. 人工小额买入 smoke：只有在卖出 smoke、对账、审计和应急停机全部稳定后才评估。

每次 smoke 必须记录：

- 操作员。
- 账户 allowlist 命中。
- proposalId。
- approvalId。
- policyResult。
- riskResult。
- liveGateResult。
- broker request id。
- broker order id。
- execution ids。
- reconciliation result。
- rollback / manual handling note。

## 影响

- 当前代码不新增真实 broker。
- 当前已新增 fake/read-only broker contract 和 QMT fake 协议测试版，但它们不连接真实券商。
- 当前默认仍为 `LIVE_TRADING=false`。
- `ManualConfirmBroker` 仍只允许 paper delegate。
- 下一步如果继续推进，应先实现只读/模拟对账模型、审批持久化和只读 smoke 设计，再评估任何真实委托。

## 不做事项

- 不实现 `QmtBroker`。
- 不实现 `PTradeBroker`。
- 不写券商账号、交易密码、客户端路径或 API key。
- 不提交真实委托。
- 不启用自动买入。
- 不把 `LIVE_TRADING=true` 作为充分条件。
- 不让 LLM、ToolRuntime 或 Research runner 持有 broker 执行能力。

## 后续动作

1. 已补 `LiveTradingGate` 领域模型、账户 allowlist 和 kill switch 状态。
2. 已补 `LiveBrokerAdapter` contract、fake adapter、ReadOnlyBroker fake adapter 和 QMT fake subprocess bridge。
3. 设计 `ReconciliationResult` 领域模型和 JSONL 审计。
4. 设计只读 broker smoke，不提交委托。
5. 只有完成对账、审批持久化和只读 smoke 后，再评估真实 QMT/PTrade 接入。
