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
- `ManualConfirmBroker` 只作为人工确认门禁，不能绕过 PolicyEngine、RiskEngine 和 AuditLog。
- 真实 BrainProvider 首选 `DashScopeQwenProvider`，`OpenAIProvider` 作为质量基准和复杂任务备选，`GeminiProvider` 作为后续多云备选。详见 `2026-06-14-brain-provider-integration-evaluation.md`。
- `GeminiProvider` 当前只完成 structured output 兼容性评估，暂缓实现；未来接入必须先收敛 JSON Schema 子集，且不得启用 Gemini 工具能力。详见 `2026-06-16-gemini-provider-structured-output-evaluation.md`。
- Tushare/AkShare 当前只完成 provider 接入评估，暂缓实现；未来接入必须先明确许可、频率限制、字段映射、缓存和失败降级。详见 `2026-06-16-tushare-akshare-provider-evaluation.md`。
- 真实 TradingAgents-CN runner 第一阶段采用外部子进程接入，不采用 HTTP 常驻服务或本地包调用，不复制其 `app/` 或 `frontend/`。详见 `2026-06-14-tradingagents-cn-runner-integration-evaluation.md`。
- U10 阶段继续暂缓自动实盘；`LIVE_TRADING=true` 不是发单充分条件，真实 broker 必须等待账户 allowlist、人工确认、PolicyEngine、RiskEngine、AuditLog、应急停机和对账全部就绪。详见 `2026-06-15-live-trading-preparation-evaluation.md`。
- 只读 broker smoke 当前只完成设计，不实现真实 broker、不写账号、不下单；未来只读 smoke 必须先经过 allowlist、kill switch、审计和失败降级。详见 `2026-06-16-read-only-broker-smoke-design.md`。
- 小额人工实盘 smoke 当前评估为 no-go；缺真实只读 smoke、真实 broker adapter、真实对账和用户外部授权。详见 `2026-06-16-small-manual-live-smoke-evaluation.md`。
- 微信通知第一阶段只做 ADR 和最小接口契约，不接真实微信、不写 token；优先候选为企业微信机器人，Server 酱仅限个人开发环境，公众号暂缓。详见 `2026-06-15-wechat-notification-design.md`。
- 题材热度第一阶段采用确定性评分模型设计，LLM 只能解释热度和提出人工复核提案，不能直接决定分数、写规则或下单。详见 `2026-06-16-theme-heat-model-evaluation.md`。
- 向量语义记忆检索第一阶段只做评估，不引入大型向量库；默认继续使用关键词检索和文件索引，未来如接 embedding 必须脱敏、缓存、可重建并可降级。详见 `2026-06-16-vector-semantic-memory-search-evaluation.md`。
