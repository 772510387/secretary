# Requirement

这里存放从原始需求整理出来的结构化需求、实现方案和工作拆分。

## 文件

- `stock-agent-implementation-plan.md`：OpenClaw 原型经验整理出的第一版完整实现方案。
- `secretary-architecture-workbreakdown.md`：架构落地工作拆分和 MVP 验收。
- `next-action-checklist.md`：从当前状态推进到 MVP 的逐步操作清单。
- `post-t014-interaction-checklist.md`：T014 完成后的细化交互清单，覆盖研究审计、手动入口、模拟闭环和实盘前置边界。
- `unimplemented-capability-checklist.md`：U1-U10 能力实现归档清单。U1-U9 已完成，U10 已完成评估；不要把它当成新的待办清单重复执行。
- `post-u10-remaining-implementation-checklist.md`：当前后续实现入口，覆盖常驻运行、完整闹钟矩阵、Webhook/API、自选股雷达、指数/放量雷达、实盘非交易性底座和人工审批入口。

## 维护规则

- 原始对话和材料放在 `docs/requirements`。
- 可执行的需求和实现清单放在本目录。
- 需求变更要同步影响到 `docs/architecture` 和目标模块 README。
