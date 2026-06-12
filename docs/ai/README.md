# Vibecoding Guide

本目录用于帮助 AI coding agent 稳定维护 `secretary`。

## 使用方式

当你要实现一个单点能力时，建议这样发起：

```text
请按 docs/ai/context-map.md 加载上下文，然后实现 src/domain/risk README 中的 PositionLimitRule。
实现前先确认测试点，完成后更新相关 README。
```

当你要修 bug 时：

```text
按 docs/ai/prompts/bugfix.md 的方式处理：先复现，再补回归测试，再修复。
```

当你要做 review 时：

```text
按 docs/ai/prompts/review.md 做代码审查，优先看资金、风控、记忆写入和实盘边界。
```

## 目录

- `context-map.md`：上下文加载地图。
- `prompts/`：常用提示词模板。
- `checklists/`：变更检查清单。
- `skills/`：项目内技能说明。

## 核心提醒

- 不要让 AI 直接实现真实下单。
- 不要把 LLM 放进硬风控链路。
- 不要用 prompt 代替代码规则。
- 不要直接从 TradingAgents-CN 专有目录复制代码。

