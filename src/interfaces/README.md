# Interfaces

`interfaces` 是系统入口层。

入口只负责协议转换，不写业务规则。

## 入口类型

- `cli`：本机命令。
- `api`：HTTP API。R3-2 已有 `runWatchMarketOnce` app 用例，可由未来 API 转成随时看盘查询；R3-3 已定义入口审计摘要模式，尚未启动真实 HTTP server。
- `webhook`：外部事件入口。R3-1 已有安全 schema 和纯函数处理器；R3-3 已补 `accessAudit`、requestId 幂等和最小限流，尚未启动真实 HTTP server。

## 入口职责

- 解析请求。
- 做必要鉴权。
- 转换为 app command。
- 调用 use case。
- 返回结果。
- Webhook 当前只返回计划和审计 metadata，不直接执行计划。
- 随时看盘入口只应转发到 `runWatchMarketOnce`，默认使用 mock/注入 provider，不在入口层联网、调用 LLM、写账户或触发 broker。
- 外部入口审计只记录 `auditId`、`requestId`、`source`、`eventType`、`result` 和拒绝原因；不得记录 token、secret header 或完整用户正文。

## 禁止

- 不在入口层计算风控。
- 不在入口层直接写账户。
- 不在入口层调用模型 SDK。
