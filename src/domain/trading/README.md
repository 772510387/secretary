# Trading Domain

负责交易意图、订单生命周期和模拟成交规则。

## 需要实现

- `TradeIntent`：已实现，交易意图，来自用户、规则或大脑建议。
- `OrderRequest`：当前由 `TradeIntent -> Order` 直接承接。
- `Order`：已实现订单模型。
- `ExecutionReport`：已实现成交回报。
- `OrderStatus`：已实现 created、validated、submitted、filled、partial、cancelled、rejected。
- `PaperExecutionPolicy`：已由 `PaperBroker` 使用交易领域模型实现模拟成交。
- `OrderIdempotency`：已由 `PaperBroker` 基于 `intent_id` 和 `orders.jsonl` 实现。

## 当前接口

```ts
import {
  createExecutionReport,
  createOrderFromIntent,
  markOrderFilled,
  markOrderRejected,
  tradeIntentSchema,
} from "./src/domain/trading/index.js";

const intent = tradeIntentSchema.parse(input);
const order = createOrderFromIntent({ orderId, intent, now });
```

## 输入

- 交易意图。
- 当前行情。
- 账户和持仓。
- 风控结果。

## 输出

- 可执行订单。
- 拒绝原因。
- 成交结果。
- 审计事件。

## 硬规则

- A 股买入必须 100 股整数倍。
- 默认只允许主板代码。
- 不允许现金为负。
- 不允许卖出超过可卖数量。
- 实盘前必须经过 BrokerAdapter。

当前 T006 已覆盖：

- 不允许现金为负。
- 不允许卖出超过可卖数量。
- `intent_id` 防重复执行。

当前 T007 已通过 `PolicyEngine` 覆盖：

- 主板过滤。
- 100 股整数买入。
- T+1。
- 现金和持仓基础规则。

## 禁止

- 不允许 LLM 直接生成最终订单。
- 不允许绕过 `risk` 模块。
- 不允许静默重试真实订单。
