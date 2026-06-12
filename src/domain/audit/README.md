# Audit Domain

负责不可抵赖的审计事件模型。

## 需要实现

- `AuditEvent`：已定义 schema 和类型。
- `AuditActor`：已定义 user、system、brain、broker、scheduler、api、cli。
- `AuditAction`：已定义 read、write、suggest、validate、order、notify、config、error。
- `AuditSubject`：已定义账户、持仓、交易、订单、记忆、配置、报告、风险、大脑、provider、storage。
- `AuditSeverity`：已定义 debug、info、warning、critical。

## 当前接口

```ts
import {
  auditEventSchema,
  type AuditEvent,
} from "./src/domain/audit/index.js";

const event: AuditEvent = auditEventSchema.parse(input);
```

## 必须审计

- 模型输出。
- 记忆写入。
- 风控拒绝。
- 模拟下单。
- 未来实盘下单和撤单。
- 配置变更。
- 异常和恢复。

## 验收

- 每条审计包含时间、actor、action、subject、result。
- 真实交易路径可以完整复盘。
- 审计日志不可由模型直接修改。

当前 schema 层已覆盖：

- 审计事件必须有 `eventId`、`occurredAt`、`actor`、`action`、`subject`、`severity`、`result`、`message`。
- `metadata` 只接受 JSON 可序列化值。
