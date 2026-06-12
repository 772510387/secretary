# Shared Domain Schemas

`shared` 存放多个领域模块都需要复用的基础数据约束。

## 当前内容

- ISO datetime。
- 交易日期。
- 货币。
- A 股 6 位代码。
- 交易市场。
- 金额。
- 数量。
- JSON metadata。

## 边界

- 只放基础值对象和 schema。
- 不放业务流程。
- 不调用文件系统、网络、模型或 broker。

