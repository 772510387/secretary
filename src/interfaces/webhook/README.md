# Webhook Interface

负责外部事件入口，例如聊天机器人、告警系统或本机自动化。

## 需要实现

- `POST /webhook/user-message`：用户自然语言请求。
- `POST /webhook/market-event`：行情异动事件。
- `POST /webhook/manual-confirm`：人工确认交易。
- `POST /webhook/system-event`：系统级事件。

## 处理要求

- 验证签名或 token。
- 解析成 app command。
- 避免重复事件。
- 写审计日志。

## 禁止

- 不允许 webhook 直接下单。
- 不允许 webhook 直接改账户 JSON。

