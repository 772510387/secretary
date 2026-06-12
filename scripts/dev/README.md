# Dev Scripts

开发辅助脚本。

## 未来脚本

- `doctor.ts`：环境检查。
- `validate-schemas.ts`：校验 schema。
- `seed-paper-account.ts`：已实现，初始化模拟账户。
- `replay-audit.ts`：回放审计事件。
- `mock-quotes.ts`：生成测试行情。

## 当前命令

```powershell
npm run seed:paper
npm run seed:paper -- --write
npm run seed:paper -- --write --reset
```

默认是 dry-run，不写文件。

`--write` 会写入：

- `memory/portfolio/account.json`
- `memory/portfolio/positions.json`
- `memory/portfolio/trades.jsonl`
- `memory/logs/audit-YYYY-MM-DD.jsonl`

已有账户文件时会拒绝覆盖，必须显式传 `--reset`。

## 要求

- 默认不改真实数据。
- 写入前打印目标路径。
- 支持 dry-run。
