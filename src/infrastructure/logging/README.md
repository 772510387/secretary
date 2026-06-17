# Logging Infrastructure

负责运行日志、错误日志和审计日志落盘。

## 需要实现

- `Logger`：结构化运行日志。
- `AuditLogWriter`：已实现，审计日志 JSONL 追加写入。
- `ErrorReporter`：异常归一化。
- `LogRedactor`：密钥和隐私脱敏。

## 当前接口

```ts
import { appendAuditEvent } from "./src/infrastructure/logging/index.js";

appendAuditEvent("memory/logs/audit-2026-06-14.jsonl", auditEvent, writer);
```

`appendAuditEvent()` 会先用 `auditEventSchema` 校验事件，再以 JSONL 追加写入。当前用于模拟账户初始化、PaperBroker 订单审计和研究报告写入审计。

## 日志类型

- app log：普通运行信息。
- audit log：资金、订单、记忆、模型输出。
- error log：异常堆栈和恢复动作。
- provider debug log：外部接口调试，默认关闭。

## 验收

- 不打印 API key。
- 真实交易路径有完整审计。
- 日志可按日期归档。
