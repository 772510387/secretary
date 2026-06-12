# Config

这里存放非敏感配置模板。

密钥不要放在这里，使用 `.env` 或本机密钥管理。

## 需要实现

- `default.example.json`：默认参数模板。
- 后续可添加 `risk.example.json`、`scheduler.example.json`。
- 配置加载逻辑放在 `src/config`。

## 配置原则

- 配置文件只保存非敏感参数。
- 实盘交易不能只靠配置文件开启，还需要运行态确认。
- 所有配置都应有 schema 校验。

