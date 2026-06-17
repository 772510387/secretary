# Logs Memory

保存审计日志和必要运行日志。

## 日志类型

- `audit-YYYY-MM-DD.jsonl`
- `heartbeat-YYYY-MM-DD.jsonl`
- `runtime-health.json`
- `app-YYYY-MM-DD.log`
- `error-YYYY-MM-DD.log`

当前已有 T004 初始化审计日志：

- `audit-2026-06-12.jsonl`

R1-2 已增加运行态健康状态：

- `runtime-health.json` 保存当前 runtime 和任务状态。
- `heartbeat-YYYY-MM-DD.jsonl` 追加 heartbeat metadata。
- heartbeat 只记录 runtimeId、taskId、状态、时间、事件名和必要 metadata。
- 最近错误只记录类型、时间和脱敏摘要，不记录 stack、密钥、账号或完整正文。

## 要求

- 审计日志追加写。
- 日志不包含密钥。
- 实盘路径必须完整记录。
- 模型不能直接修改日志。
- health/heartbeat 不保存账户详情、API key、token、完整 prompt 或完整研究报告正文。
