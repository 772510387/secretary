# Storage Infrastructure

负责本地 JSON、备份、原子写入和未来 SQLite。

## 需要实现

- `JsonStore<T>`：已实现，负责读取、校验、写入和 update。
- `AtomicFileWriter`：已实现，使用同目录临时文件 + rename。
- `BackupManager`：已实现，覆盖前备份到同级 `.backups`。
- `ReportsMemoryStore`：已实现，负责报告写入 `memory/reports`。
- `ResearchMemoryStore`：已实现，负责研究报告写入 `memory/research`。
- `SchemaRegistry`：加载 `data/schemas`。
- `MigrationRunner`：未来 schema 升级。

## 写入要求

- 写入前校验 schema。
- 写入前备份。
- 写入失败不破坏原文件。
- 重要写入生成审计事件。

## 当前接口

```ts
import { z } from "zod";
import {
  JsonStore,
  initializePaperAccountMemory,
} from "../../src/infrastructure/storage/index.js";

const accountSchema = z.object({
  accountId: z.string(),
  cash: z.number().nonnegative(),
});

const store = new JsonStore({
  filePath: "memory/portfolio/account.json",
  schema: accountSchema,
});

store.write({ accountId: "paper", cash: 20000 });
const account = store.read();
```

`JsonStore.write()` 会先进行 schema 校验。只有校验通过才会调用 `AtomicFileWriter`，因此非法数据不会触发备份，也不会破坏原文件。

`AtomicFileWriter` 默认行为：

- 自动创建父目录。
- 如果目标文件存在，先复制到 `.backups`。
- 写入同目录临时文件。
- 使用 `rename` 替换目标文件。
- 出错时删除临时文件并抛出 `StorageError`。

`initializePaperAccountMemory()` 已用于 T004 初始化模拟账户：

- 写入 `memory/portfolio/account.json`。
- 写入 `memory/portfolio/positions.json`。
- 创建空 `memory/portfolio/trades.jsonl`。
- 追加 `memory/logs/audit-YYYY-MM-DD.jsonl`。
- 默认 dry-run，不覆盖已有账户文件。
- 只有 `reset=true` 才允许覆盖并创建备份。

`ReportsMemoryStore.writeReport()` 已用于 T013 报告生成：

- 写入 `memory/reports/YYYY-MM-DD/{reportType}.json`。
- 写入前使用 `generatedReportSchema` 校验。
- 重复写入同一报告时会通过 `AtomicFileWriter` 创建备份。
- 报告建议只允许非执行草案，不直接进入 broker。

`ResearchMemoryStore.writeReport()` 已用于 T014 研究报告落盘：

- 写入 `memory/research/YYYY-MM-DD/{reportId}.json`。
- 写入前使用 `researchReportSchema` 校验。
- 重复写入同一研究报告时会通过 `AtomicFileWriter` 创建备份。
- 研究报告里的交易建议只能是 `TradeIntentDraft`，不能直接执行。

## 首批存储对象

- 账户。
- 持仓。
- 交易流水。
- 规则配置。
- 研究报告。
- 记忆提案。
- 审计日志。

## 后续

T003 会在 `data/schemas` 和领域模块里定义账户、持仓、交易流水、审计事件等业务 schema。当前 T002 只提供通用存储能力。
