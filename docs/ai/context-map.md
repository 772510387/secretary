# AI Context Map

本文件定义 AI 在不同任务下应该读取哪些上下文，避免每次都读全仓库。

## 默认上下文

任何任务先读：

1. `AGENTS.md`
2. `README.md`
3. `docs/architecture/README.md`
4. `docs/architecture/module-map.md`

## 实现领域规则

再读：

- `src/domain/README.md`
- 目标模块 `README.md`
- `tests/unit/README.md`
- 相关 `data/schemas/README.md`

适用任务：

- 风控。
- 交易规则。
- 账户计算。
- 记忆策略。
- 小脑触发规则。

## 实现外部适配

再读：

- `src/infrastructure/README.md`
- 目标基础设施模块 `README.md`
- `tests/integration/README.md`
- `.env.example`
- `config/default.example.json`

适用任务：

- 行情 provider。
- LLM provider。
- broker。
- storage。
- scheduler。

## 实现入口

再读：

- `src/interfaces/README.md`
- 目标入口模块 `README.md`
- `src/app/README.md`
- `src/runtime/README.md`

适用任务：

- CLI。
- API。
- Webhook。

## 实现 AI/研究能力

再读：

- `src/domain/brain/README.md`
- `src/domain/research/README.md`
- `src/infrastructure/providers/README.md`
- `memory/research/README.md`
- `docs/architecture/decision-records/2026-06-12-secretary-core-with-research-adapter.md`

## 实盘相关任务

再读：

- `src/infrastructure/broker/README.md`
- `docs/ops/live-trading-readiness.md`
- `src/domain/risk/README.md`
- `src/domain/audit/README.md`

实盘相关改动必须默认保持关闭。

