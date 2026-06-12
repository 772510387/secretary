# Portfolio Memory

保存账户、持仓、交易流水和每日快照。

## 未来文件

- `account.json`：已由 T004 初始化。
- `positions.json`：已由 T004 初始化为空数组。
- `trades.jsonl`：已由 T004 初始化为空流水。
- `orders.jsonl`：由 T006 `PaperBroker` 首次下单时创建。
- `daily-snapshots/`

## 写入来源

- `PaperBroker`
- 未来 `BrokerAdapter` 对账
- 初始化 seed

## 要求

- 金额和数量写入前必须校验。
- 每次交易后生成流水。
- 每日收盘后生成快照。

## 当前初始化

当前模拟账户：

- accountId：`paper-main`
- 初始资金：`20000`
- 币种：`CNY`
- 类型：`paper`

重复初始化默认会拒绝覆盖，除非通过：

```powershell
npm run seed:paper -- --write --reset
```
