# Config

这里存放非敏感配置模板。

密钥不要放在这里，使用 `.env` 或本机密钥管理。

## 需要实现

- `default.example.json`：默认参数模板。
- 后续可添加 `risk.example.json`、`scheduler.example.json`。
- 配置加载逻辑放在 `src/config`。
- 未来实盘账户 allowlist 已由 `LiveAccountAllowlist` schema 和 `LiveTradingSafetyStore` 承接，落盘位置为 `memory/broker/live-account-allowlist.json`，不放真实账号样例。

## 配置原则

- 配置文件只保存非敏感参数。
- 实盘交易不能只靠配置文件开启，还需要运行态确认。
- 所有配置都应有 schema 校验。
- 账户 allowlist 不允许通配；缺 allowlist 默认拒绝；展示和审计必须使用脱敏账户标识。
