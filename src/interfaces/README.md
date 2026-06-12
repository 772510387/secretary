# Interfaces

`interfaces` 是系统入口层。

入口只负责协议转换，不写业务规则。

## 入口类型

- `cli`：本机命令。
- `api`：HTTP API。
- `webhook`：外部事件入口。

## 入口职责

- 解析请求。
- 做必要鉴权。
- 转换为 app command。
- 调用 use case。
- 返回结果。

## 禁止

- 不在入口层计算风控。
- 不在入口层直接写账户。
- 不在入口层调用模型 SDK。

