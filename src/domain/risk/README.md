# Risk Domain

负责交易前、盘中、盘后所有硬风控。

## 需要实现

- `PolicyEngine`：已实现交易制度规则，例如主板、T+1、100 股、现金和持仓基础校验。
- `RiskEngine`：已实现仓位、止损、单日亏损、禁买、熔断。
- `RiskCheckResult`：已实现 passed、warning、rejected 和 blocking violations。
- `HardStopRule`：已实现 8% 硬止损 critical 事件。
- `PositionLimitRule`：已实现单股最高 40%。
- `DailyLossLimitRule`：已实现单日最大亏损。
- `NoBuyState`：已实现禁买状态。
- `CircuitBreaker`：已实现系统级熔断。

## 输入

- 交易意图。
- 账户和持仓。
- 行情快照。
- 历史交易。
- 当前运行状态。

## 输出

- 风控结论。
- 拒绝原因。
- 告警事件。
- 是否允许进入人工确认。

## 当前接口

```ts
import {
  PolicyEngine,
  RiskEngine,
  checkOrderPolicy,
  checkRisk,
  isMainBoardSymbol,
} from "./src/domain/risk/index.js";

const result = checkOrderPolicy({
  order,
  account,
  positions,
  options: {
    mainBoardOnly: true,
    lotSize: 100,
    t1Enabled: true,
  },
});
```

RiskEngine：

```ts
const result = checkRisk({
  account,
  positions,
  order,
  dailyLoss: {
    baselineAssets: 20000,
    currentAssets: 19400,
  },
  runtimeState: {
    noBuy: false,
    circuitBreaker: false,
  },
  options: {
    maxSinglePositionRatio: 0.4,
    hardStopLossRatio: 0.08,
    dailyLossLimitRatio: 0.03,
  },
});
```

## PolicyEngine 当前规则

- 默认只允许 A 股主板：
  - 上交所：`600`、`601`、`603`、`605`
  - 深交所：`000`、`001`、`002`、`003`
- 买入数量必须是 `lotSize` 整数倍，默认 100 股。
- 买入需要有足够可用现金。
- 卖出必须存在对应持仓。
- 卖出不能超过 `calculateSellableQuantity()` 得出的可卖数量。
- 默认启用 T+1。
- 账户必须匹配且处于 `active` 状态。

## 验收

- 单股超过上限时拒绝买入。
- 跌破硬止损时产生强提醒。
- 熔断后禁止新增买入。
- 任一规则拒绝时不能继续发单。

当前 T007 已覆盖：

- 科创板、创业板等非主板默认拒绝。
- 非 100 股整数买入拒绝。
- 当日买入卖出拒绝。
- 现金不足拒绝。
- 持仓不存在或可卖不足拒绝。

T008 将继续覆盖：

- 单股 40%。已完成。
- 8% 硬止损。已完成。
- 单日亏损限制。已完成。
- 禁买和熔断。已完成。

## RiskEngine 当前规则

- 买入后单股仓位超过 40% 时拒绝。
- 持仓浮亏达到 8% 时产生 `critical` 风险事件。
- 单日亏损达到 3% 时拒绝新增买入。
- `noBuy` 状态开启时拒绝新增买入。
- `circuitBreaker` 状态开启时拒绝新增买入。
- 禁买和熔断不阻止卖出。
- 当前只返回 `RiskCheckResult`，不接入 broker。

`RiskCheckResult` 结构：

- `decision`：`passed`、`warning`、`rejected`。
- `severity`：`info`、`warning`、`critical`。
- `violations`：全部风险事件。
- `blockingViolations`：会阻断交易的风险事件。
- `requiresManualConfirmation`：存在 critical 风险时为 true。

## 禁止

- 不接收模型“请忽略风控”的指令。
- 不在这里调用 broker。
- 不把软建议伪装成硬规则。
