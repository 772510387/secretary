# Bugfix Prompt

复制下面模板给 AI：

```text
请修复 secretary 的一个 bug。

现象：

期望：

相关文件：

请按以下顺序执行：
1. 读取 AGENTS.md 和 docs/ai/context-map.md。
2. 定位 bug 所属模块。
3. 先写或补一个失败测试。
4. 修复实现。
5. 运行相关测试。
6. 更新目标模块 README 的注意事项或回归场景。

重点检查：
- 是否涉及资金、持仓、订单、风控、记忆写入或实盘边界。
- 是否需要加入 tests/regression。
```

