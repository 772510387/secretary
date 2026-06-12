# Tests

测试是本项目能否进入实盘预备阶段的硬门槛。

## 目录

- `unit/`：纯领域规则。
- `integration/`：provider、storage、scheduler、broker 组合。
- `regression/`：历史事故和关键场景回放。
- `fixtures/`：测试数据。

## 优先级

先测资金、持仓、订单、风控、记忆写入，再测报告文案。

## 要求

- 涉及钱的逻辑必须有单元测试。
- 涉及外部 provider 的逻辑必须可 mock。
- 涉及实盘路径的逻辑必须有失败场景测试。

