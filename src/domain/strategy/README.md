# Strategy Domain

命名策略层负责把人能理解的策略 ID（如 `BUY-001`）桥接到现有的回放决策和软经验统计。

## 边界

- 只定义策略本体、状态和 regime 指纹匹配。
- 不读写文件。
- 不计算账户、下单或风控结果。
- 胜率、样本和案例必须由已评分决策派生，不能由模型直接填写。

## 当前接口

```ts
import {
  DEFAULT_NAMED_STRATEGIES,
  deriveStrategyIdsForStance,
} from "./src/domain/strategy/index.js";

const strategyIds = deriveStrategyIdsForStance({
  bias: "reduce",
  basis: {
    trend: "uptrend",
    technicalAsOfDate: "2026-06-26",
    rangePosition60: 0.92,
    closeVsMa20: 0.04,
  },
});
```

## 规则

- `strategyId` 是审计线索，不是交易许可。
- 命名策略只提供解释和归因，不能绕过 `PolicyEngine` / `RiskEngine`。
- 生命周期建议（提炼、复核、淘汰）必须走人工复核提案链。
