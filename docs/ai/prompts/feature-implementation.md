# Feature Implementation Prompt

复制下面模板给 AI：

```text
请在 secretary 中实现一个单点能力。

任务：
- 实现：
- 目标目录：
- 目标 README：

请按以下顺序执行：
1. 读取 AGENTS.md。
2. 读取 docs/ai/context-map.md。
3. 读取目标模块 README。
4. 先给出实现边界和测试点。
5. 实现代码。
6. 补单元或集成测试。
7. 更新相关 README。
8. 运行可用的验证命令。

约束：
- 不引入实盘交易默认开启。
- 不让 LLM 绕过风控。
- 不写入密钥。
- 不复制 TradingAgents-CN 的专有 app/frontend 代码。
```

