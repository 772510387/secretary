# Architecture Decision Records

这里记录重要架构决策。

## 格式

文件命名：

```text
YYYY-MM-DD-short-title.md
```

建议结构：

```md
# 决策标题

## 背景

## 决策

## 影响

## 替代方案

## 后续动作
```

## 已确认决策

- 自研 `secretary` 作为主系统。
- OpenClaw 只作为原型经验来源。
- TradingAgents-CN 只作为可选深度研究顾问和设计参考。
- 第一阶段使用 JSON 文件和 schema，后续再评估 SQLite。
- 实盘交易必须隔离在 BrokerAdapter 后方，且默认关闭。

