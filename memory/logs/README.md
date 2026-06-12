# Logs Memory

保存审计日志和必要运行日志。

## 日志类型

- `audit-YYYY-MM-DD.jsonl`
- `app-YYYY-MM-DD.log`
- `error-YYYY-MM-DD.log`

当前已有 T004 初始化审计日志：

- `audit-2026-06-12.jsonl`

## 要求

- 审计日志追加写。
- 日志不包含密钥。
- 实盘路径必须完整记录。
- 模型不能直接修改日志。
