# CLI Interface

负责本机命令行入口。

## 需要实现

- `secretary doctor`：环境检查。
- `secretary quote <symbol>`：查询行情。
- `secretary portfolio`：查看账户。
- `secretary buy --paper`：模拟买入。
- `secretary sell --paper`：模拟卖出。
- `secretary report daily`：生成日报。
- `secretary memory search`：检索记忆。

## 用途

- 开发调试。
- 本机运维。
- 手动触发任务。
- 回归测试辅助。

## 验收

- 命令输出清晰。
- 失败时返回非零退出码。
- 真实交易命令必须有显式确认。

