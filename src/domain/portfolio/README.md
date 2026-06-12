# Portfolio Domain

负责账户、现金、持仓、成本、盈亏和交易流水。

## 需要实现

- `Account`：已定义 schema 和类型。
- `CashBalance`：已定义 schema 和类型。
- `Position`：已定义 schema 和类型。
- `TradeRecord`：已定义 schema 和类型。
- `PortfolioSnapshot`：后续实现指定时间点账户快照。
- `PositionValuator`：已实现单仓市值、成本、浮盈浮亏、收益率、仓位比例。
- `T1AvailabilityCalculator`：已实现 A 股 T+1 可卖数量。

## 当前接口

```ts
import {
  accountSchema,
  calculatePortfolioValuation,
  calculateSellableQuantity,
  positionSchema,
  tradeRecordSchema,
  type Account,
  type Position,
  type TradeRecord,
} from "./src/domain/portfolio/index.js";

const account: Account = accountSchema.parse(input);
const valuation = calculatePortfolioValuation(account, positions);
```

## 计算口径

- 金额：统一四舍五入到 2 位。
- 价格/成本价：统一四舍五入到 4 位。
- 比例：统一四舍五入到 6 位。
- 市值：`quantity * latestPrice`。
- 成本：`quantity * costPrice`。
- 浮盈浮亏：`marketValue - costBasis`。
- T+1 可卖：`quantity - todayBuyQuantity - frozenQuantity`。
- 保守可卖：`min(availableQuantity, T+1 可卖)`。

## 当前计算接口

- `calculateCashSummary(account)`
- `calculateCostBasis(position)`
- `calculateMarketValue(position, latestPrice?)`
- `calculateUnrealizedPnl(position, latestPrice?)`
- `calculateUnrealizedPnlRatio(position, latestPrice?)`
- `calculateT1AvailableQuantity(position, options?)`
- `calculateSellableQuantity(position, options?)`
- `calculateAverageCostAfterBuy(input)`
- `calculateRealizedCost(quantity, costPrice)`
- `calculatePositionValuation(position, options?)`
- `calculatePortfolioValuation(account, positions, options?)`

## 输入

- 账户数据。
- 交易流水。
- 当前行情。

## 输出

- 资产净值。
- 持仓市值。
- 单股仓位比例。
- 可买金额。
- 可卖数量。

## 验收

- 买入后当日不可卖。已由 `calculateT1AvailableQuantity` 覆盖。
- 卖出不能超过可卖数量。已提供 `calculateSellableQuantity`，T006/T007 会接入。
- 成本价、现金、持仓数量计算准确。已由单元测试覆盖。
- 所有金额计算统一精度策略。已定义金额 2 位、价格 4 位、比例 6 位。

当前 schema 层已覆盖：

- 账户现金不能为负。
- 持仓数量、可卖数量、冻结数量不能为负。
- 可卖数量和冻结数量不能合计超过总持仓。
- 交易流水必须有合法方向、数量、价格、金额和交易日期。

## 禁止

- 不在这里调用行情接口。
- 不在这里写文件。
- 不在这里判断 LLM 建议是否合理。
