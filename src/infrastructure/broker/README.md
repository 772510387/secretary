# Broker Infrastructure

负责模拟盘、人工确认和未来真实券商接口。

## 需要实现

- `BrokerAdapter`：统一接口。
- `PaperBroker`：已实现模拟盘买入、卖出、拒单和 `intent_id` 防重复。
- `ManualConfirmBroker`：半自动确认。
- `ReadOnlyBroker`：只同步账户，不交易。
- `QmtBroker`：未来 QMT。
- `PTradeBroker`：未来 PTrade。

## BrokerAdapter 能力

- 查询账户。
- 查询持仓。
- 查询可卖数量。
- 提交订单。`PaperBroker.submitOrder()` 已实现。
- 查询订单。`PaperBroker.getOrders()` 已实现。
- 查询成交。
- 撤单。

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

## 实盘要求

- 默认关闭。
- 下单前重新查询账户和持仓。
- 每个订单有 `intent_id`。
- 下单和成交都要审计。
- 失败不得静默重试。

## 禁止

- 禁止模拟点击交易客户端。
- 禁止保存明文交易密码。
- 禁止让 LLM 持有 broker 对象。
