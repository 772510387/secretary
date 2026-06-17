# Broker Infrastructure

负责模拟盘、人工确认和未来真实券商接口。

## 需要实现

- `LiveBrokerAdapter`：已定义未来 live broker 的最小统一接口，并提供 `FakeLiveBrokerAdapter` contract test 版。
- `PaperBroker`：已实现模拟盘买入、卖出、拒单和 `intent_id` 防重复。
- `ManualConfirmBroker`：已实现第一阶段 paper-only 人工确认门禁，不是真实券商实现。
- `LiveTradingGate`：已实现未来 live delegate 前的准入矩阵，读取 allowlist 和 kill switch，写审计 metadata，但不接真实 broker、不下单。
- `ReadOnlyBroker`：已实现 fake 只读适配器，只查询账户、资金、持仓、委托和成交，并审计 metadata。
- `QmtFakeSubprocessBridge`：已实现 QMT fake 子进程桥接协议测试版，只支持查询类命令和错误返回。
- `QmtBroker`：未来 QMT。
- `PTradeBroker`：未来 PTrade。

## BrokerAdapter 能力

- 查询账户。
- 查询资金。
- 查询持仓。
- 查询可卖数量。
- 提交订单。`PaperBroker.submitOrder()` 已实现。
- 提交 live 委托。`LiveBrokerAdapter.submitOrder()` 必须显式接收 `LiveTradingGateResult`。
- 查询订单。`PaperBroker.getOrders()` 已实现。
- 查询成交。
- 撤单。`FakeLiveBrokerAdapter.cancelOrder()` 只做 contract 演练，不接真实 broker。

## PaperBroker 当前行为

```ts
import { PaperBroker } from "./src/infrastructure/broker/index.js";

const broker = new PaperBroker({ memoryDir: "memory" });
const result = broker.submitOrder(intent);
```

写入文件：

- `memory/portfolio/account.json`
- `memory/portfolio/positions.json`
- `memory/portfolio/trades.jsonl`
- `memory/portfolio/orders.jsonl`
- `memory/logs/audit-YYYY-MM-DD.jsonl`

规则：

- 买入扣可用现金。
- 买入新增或更新持仓。
- 买入当天不增加 `availableQuantity`，会增加 `todayBuyQuantity`。
- 卖出增加可用现金。
- 卖出使用 `calculateSellableQuantity()` 做 T+1 可卖校验。
- 现金不足会拒单。
- 可卖数量不足会拒单。
- 重复 `intentId` 返回原订单结果，不重复成交。
- 通过 `PolicyEngine` 拦截非主板、非 100 股买入、账户不匹配、账户非 active。
- 默认佣金和税费为 0，可注入 fee calculator。

未覆盖：

- 单股 40% 仓位限制。
- 8% 止损。

这些会在 T008 进入 `RiskEngine`。

## ManualConfirmBroker 当前行为

详细边界决策见：

- `docs/architecture/decision-records/2026-06-14-manual-confirm-broker-boundary.md`

`ManualConfirmBroker` 的定位是人工确认门禁：

```text
TradeIntentReviewProposal(status=approved)
  -> deterministic TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> ManualConfirmBroker
  -> PaperBroker or future LiveBroker delegate
  -> AuditLog
```

```ts
import {
  ManualConfirmBroker,
  PaperBroker,
} from "./src/infrastructure/broker/index.js";

const paperBroker = new PaperBroker({ memoryDir: "memory" });
const broker = new ManualConfirmBroker({
  memoryDir: "memory",
  delegate: paperBroker,
});

const result = broker.submitApprovedProposal({
  proposal: approvedTradeIntentReviewProposal,
  approval: {
    approvalId: "approval-001",
    proposalId: approvedTradeIntentReviewProposal.proposalId,
    decision: "approved",
    approvedAt: new Date().toISOString(),
    approvedBy: { type: "user", id: "operator-001" },
  },
  accountId: "paper-main",
});
```

当前实现：

- 构造函数只接受 `delegateKind=paper`，传入非 paper delegate 会拒绝。
- 只处理 `trade_intent_review` 且 `status=approved` 的提案。
- 必须传入完整 approval 记录，且 `approval.proposalId` 必须匹配。
- `pending_review`、`rejected`、`applied`、过期、撤销、approval 过期或撤销都会拒绝，且不会调用 `PaperBroker`。
- `HOLD`、`WATCH` 或缺少 `quantity` / `limitPrice` 的提案不会进入 broker。
- handoff 前会重新构造确定性 `TradeIntent`，读取 paper 账户和持仓，并重跑 `PolicyEngine` 与 `RiskEngine`。
- `PolicyEngine` 拒绝或 `RiskEngine` 阻断时，不会调用 `PaperBroker`。
- 校验通过后才调用 `PaperBroker.submitOrder()`，由 `PaperBroker` 负责模拟账户、持仓、订单、成交和订单审计。
- `ManualConfirmBroker` 额外写入 handoff 审计，记录 `proposalId`、`approvalId`、`policyResult`、`riskResult`、`delegateBroker=paper`、`intentId` 和 delegate 结果摘要。
- 审计不记录完整研究正文、提案 rationale、reviewReason、券商密钥或真实交易参数。

人工确认前：

- `trade_intent_review` 提案保持 `pending_review`。
- `executable=false`。
- `brokerSubmissionAllowed=false`。
- 不允许进入 `PaperBroker`。
- 不允许生成最终订单。

人工确认后：

- `approved` 只表示“允许进入交易前校验”。
- 仍然必须重新构造确定性的 `TradeIntent`。
- 仍然必须经过 `PolicyEngine`。
- 仍然必须经过 `RiskEngine`。
- 仍然必须写入审计。
- 只有校验通过后，才能交给 paper delegate 或未来 live delegate。

`ManualConfirmBroker` 不允许：

- 直接消费 LLM 输出。
- 直接消费 `ResearchReport`。
- 直接消费 `pending_review` 提案。
- 绕过策略或风控。
- 自己修改账户、持仓、订单或交易流水。
- 保存真实 broker 密钥或交易密码。
- 在缺少审计记录时提交订单。

未来接入 `PaperBroker` 时，`PaperBroker` 仍然负责模拟账户、持仓、订单、成交和审计写入。`ManualConfirmBroker` 只负责确认门禁和前置校验编排。

未来接入 live broker 时，必须重新查询真实账户、持仓和可卖数量，并在提交前后记录审计和对账结果。

## LiveTradingGate 当前行为

`LiveTradingGate` 的定位是未来 live delegate 前的非交易性安全门禁：

```text
manual approval + deterministic TradeIntent
  -> PolicyEngine
  -> RiskEngine
  -> LiveTradingGate
  -> future fake/read-only/live delegate
```

```ts
import { LiveTradingGate } from "./src/infrastructure/broker/index.js";

const gate = new LiveTradingGate({ memoryDir: "memory" });
const result = gate.evaluate({
  liveTradingEnvEnabled: process.env.LIVE_TRADING === "true",
  tradingMode: "live",
  brokerProvider: "fake_live",
  accountId: "local-test-account",
  symbol: "000001",
  market: "SZSE",
  manualConfirmation,
  policyResult,
  riskResult,
});
```

当前实现：

- `LIVE_TRADING=true` 仍不足以通过。
- 必须命中 `memory/broker/live-account-allowlist.json`。
- 必须存在人工确认记录。
- 必须传入 `PolicyEngine` 通过结果。
- 必须传入 `RiskEngine` 通过结果。
- 必须读取 `memory/risk/kill-switch.json`，且无阻断规则。
- 必须能写入 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 审计只记录 metadata，例如脱敏账户、reason codes、brokerProvider、kill switch rule ids，不记录真实账号、密钥或完整提案正文。
- 只返回准入结果，不调用真实 broker、不调用 `PaperBroker`、不写订单、不写交易流水。

## LiveBrokerAdapter 当前行为

`LiveBrokerAdapter` 是未来真实 broker 的最小 contract，不是当前真实交易能力。

当前只实现：

- `FakeLiveBrokerAdapter`：内存 fake adapter，用于 contract test。
- `getAccountSnapshot()` / `getCash()` / `getPositions()` / `getOrders()` / `getExecutions()` 查询接口。
- `submitOrder(input)`：必须传入 `LiveTradingGateResult`；gate 未通过时直接返回 rejected，不调用 fake broker 侧提交。
- `cancelOrder(input)`：同样要求 gate 结果，只做 fake cancel contract 演练。
- fake submit 覆盖 `accepted`、`rejected`、`unknown`、`timeout` 和重复 `requestId` 幂等返回。

当前不做：

- 不接真实 QMT、PTrade 或其他券商。
- 不写真实账户、客户端路径、交易密码或 API token。
- 不根据 LLM 输出直接提交委托。
- 不更新真实账户、持仓、订单或成交。

## ReadOnlyBroker 当前行为

`ReadOnlyBroker` 用于未来只读 smoke 的接口边界。当前实现为 `FakeReadOnlyBroker`：

- 只能查询账户快照、资金、持仓、委托和成交。
- 类上没有 `submitOrder` 或 `cancelOrder` 能力。
- 每个读取请求都会写入 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 审计只记录 `requestId`、脱敏账户、subject、recordCount 和只读能力 metadata。
- 不记录真实账号、secret header、token、交易密码或完整账户明细。
- 不联网、不连接真实 broker。

## QMT fake subprocess bridge 当前行为

`QmtFakeSubprocessBridge` 只定义 fake 子进程协议，供后续 QMT 真实桥接前做 contract test：

- stdin 请求协议版本为 `secretary.qmt.fake-bridge.v1`。
- stdout 支持完整 JSON 或 `SECRETARY_QMT_RESULT_JSON:` 前缀 JSON。
- 只允许查询类命令：`get_account_snapshot`、`get_cash`、`get_positions`、`get_orders`、`get_executions`、`health_check`。
- 请求 options 固定为 `fake_read_only`，且 `allowNetwork=false`、`allowMiniQmt=false`、`allowBroker=false`、`allowOrders=false`、`allowAccountSecrets=false`。
- stderr 和错误消息会脱敏。
- 超时会终止 fake 子进程。

当前不调用 MiniQMT，不写账号，不联网，不下单。

## 实盘要求

- 默认关闭。
- 下单前重新查询账户和持仓。
- 每个订单有 `intent_id`。
- 下单和成交都要审计。
- 失败不得静默重试。
- `LIVE_TRADING=true` 不足以发实盘单。
- `LIVE_TRADING=true` 不足以通过 `LiveTradingGate`，仍必须通过 allowlist、人工确认、PolicyEngine、RiskEngine、kill switch 和审计可写检查。
- 人工确认不足以绕过 `PolicyEngine` 和 `RiskEngine`。
- 真实 broker delegate 必须有单独启用条件、账户允许列表、人工确认记录、风控通过记录和对账流程。

U10 预备评估见：

- `docs/architecture/decision-records/2026-06-15-live-trading-preparation-evaluation.md`
- `docs/ops/live-trading-readiness.md`

当前结论：

- 已实现 `LiveBrokerAdapter` contract、`FakeLiveBrokerAdapter`、`FakeReadOnlyBroker` 和 `QmtFakeSubprocessBridge` fake 协议。
- 不实现真实 `QmtBroker`。
- 不实现 `PTradeBroker`。
- 不接真实 broker。
- QMT 未来只作为外部 Python 子进程桥接候选。
- PTrade 未来只作为券商侧托管平台候选。
- 任何 live delegate 都必须先通过 `LiveTradingGate`、账户 allowlist、人工确认、PolicyEngine、RiskEngine、AuditLog、应急停机和对账。

## 禁止

- 禁止模拟点击交易客户端。
- 禁止保存明文交易密码。
- 禁止让 LLM 持有 broker 对象。
- 禁止把 `approved` 提案直接当作订单。
