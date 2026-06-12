# Infrastructure

`infrastructure` 负责外部世界适配。

## 模块

- `storage`：文件和未来数据库。
- `providers`：行情、新闻、LLM、研究工具。
- `scheduler`：已实现定时器、北京时间、交易时段任务、任务锁和优雅停止。
- `broker`：模拟盘、人工确认、未来实盘券商。
- `logging`：日志和审计落盘。

## 实现原则

- 对外部 SDK 做薄封装。
- 把原始返回转换成 domain 结构。
- 错误要显式返回或抛出领域可理解的异常。
- 不把外部数据结构泄漏到 `domain`。
