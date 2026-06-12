# Data

`data` 存放运行所需的数据契约、种子数据和可清理缓存。

## 目录

- `schemas/`：JSON schema 和类型契约。
- `seeds/`：初始化数据。
- `cache/`：行情、新闻、provider 原始响应缓存。

## 规则

- `schemas` 和 `seeds` 可以提交。
- `cache` 默认不提交实际缓存。
- 账户、交易和长期记忆优先放在 `memory`，不是 `data/cache`。

