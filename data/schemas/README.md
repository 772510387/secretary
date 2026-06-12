# Schemas

存放 JSON schema 或 Zod schema 的说明和导出。

## 首批 schema

- `account.schema.json`：已添加。
- `position.schema.json`：已添加。
- `trade-record.schema.json`：已添加。
- `quote-snapshot.schema.json`
- `research-report.schema.json`
- `memory-proposal.schema.json`
- `audit-event.schema.json`：已添加。

运行时校验以 `src/domain/*/schemas.ts` 中的 Zod schema 为准；本目录 JSON Schema 用于契约说明、迁移和后续跨语言工具。

## 要求

- 写入文件前必须通过 schema。
- schema 变更需要迁移说明。
- 测试 fixtures 要覆盖 schema 的正例和反例。

当前 fixtures：

- `tests/fixtures/account.valid.json`
- `tests/fixtures/account.invalid.json`
- `tests/fixtures/position.valid.json`
- `tests/fixtures/position.invalid.json`
- `tests/fixtures/trade-record.valid.json`
- `tests/fixtures/trade-record.invalid.json`
- `tests/fixtures/audit-event.valid.json`
- `tests/fixtures/audit-event.invalid.json`
