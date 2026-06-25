# 飞书双向助手（默认接入）

生成日期：2026-06-21

把“你在飞书里发消息 → secretary 执行/回复”接通，这是本项目**默认的对话接入方式**
（`npm start` 即启动飞书机器人）。架构与 OpenClaw 一致：飞书通道适配器 → 归一化 →
`runAgentTurn`（同一个指令大脑）→ 回复发回。

走飞书官方**长连接（WebSocket）**：用的是官方机器人 API，**无封号风险**，且机器人主动
拨出连接，**家用网络无需公网 IP / 内网穿透**。相比个人微信（`npm run wechat:bot`，有
违反 ToS 的封号风险），飞书是推荐通道。

## 能做什么

- 杂项问答：读真实模拟盘 DB + 实时行情 + 日线技术指标 + 大盘指数 → 模型回答；
  分析类问题自动触发 Tavily 联网检索（`buildBridgeContext`）。
- 跑固定流程（SOP）：直接说「做个盘前计划」「来个收盘复盘」「帮我深度复盘」，模型会从
  18 个 SOP 里按含义挑一个执行（盘前计划 / 早盘·午间·收盘回顾 / 风险扫描 / 深度·周·月·年复盘…）。
- 自然语言指令：清库重置、构建账户（危险操作需**对话式二次确认**）。
- 问项目能力与流程。

## 路由是模型驱动的（不是关键词规则）

每条消息先经过一次**模型路由**（`planAgentTurn`）：模型读消息判断意图（问答 / 跑哪个 SOP /
清库 / 建账户），而不是用正则匹配关键词。安全闸仍是确定性的——清库/建账户**永远**要二次确认、
模型**永远**不能执行工具/下单/改账户。模型不可用或返回异常时，自动降级回确定性关键词分类，不会卡死。

想看路由效果：`npm run plan:smoke`（用真实大脑把几条样例消息路由一遍并打印结果）。

只支持**私聊**（`chat_type=p2p`），群聊忽略；只处理文本消息。

## 安全模型

- **owner 白名单**（`FEISHU_ALLOWED_USERS`，逗号分隔的 `open_id`）：
  - 白名单为空：任何人都能问答（只读），但**清库/建账户被禁用**。
  - 白名单非空：只有名单内的 `open_id` 能下危险指令。
- **危险操作走对话确认**：飞书里没有 `--yes`，发“清除模拟盘数据”后机器人会要求你回复
  『确认』才执行，回复『取消』放弃。
- 红线不变：**不接真实券商、不自动实盘、模型不能执行任何工具**。

## 一次性配置（飞书开放平台）

1. 到 https://open.feishu.cn → 创建**自建应用** → 拿到 **App ID / App Secret**。
2. 「事件订阅」选择**长连接（WebSocket）模式**，订阅事件 `im.message.receive_v1`。
3. 「权限管理」添加 `im:message`（接收与回复单聊消息）相关权限，发布版本。
4. 把应用加为机器人，确保能私聊它。

## 配置 `.env`

```env
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
# 你的 open_id（首次私聊时机器人日志会打印），填进来才能下清库/建账户指令
FEISHU_ALLOWED_USERS=ou_xxxxxxxx

# 真实对话需要真实大脑（否则 mock 只回固定模板）
BRAIN_PROVIDER=dashscope
DASHSCOPE_API_KEY=sk-xxxxxxxx
# 联网检索（可选）
SEARCH_PROVIDER=tavily
TAVILY_API_KEY=tvly-xxxxxxxx
```

## 启动

```powershell
npm start          # 等价于 npm run feishu:bot
```

看到 `✅ 飞书机器人已通过长连接启动` 后，直接在飞书里私聊这个应用即可对话。
首次私聊后，日志会打印你的 `open_id`，把它填进 `FEISHU_ALLOWED_USERS` 即可开放危险操作。

`Ctrl+C` 退出。

## 诚实提醒

- 入口已带 `cross-env NODE_USE_ENV_PROXY=1`，与其它对话入口一致。本机在 Clash 代理后：
  飞书长连接与 DashScope 为国内直连，Tavily（境外）走代理；Clash 一般按规则分流，不影响
  国内服务。若不需要联网检索，`SEARCH_PROVIDER=none` 即可。
- `@larksuiteoapi/node-sdk` 已在依赖中，无需另装。
- 想同时把哨兵异动推给你：另开一个进程 `npm run sentinel:dev -- --live`（外部推送走飞书，
  设 `FEISHU_NOTIFY=1`）。飞书机器人负责“你问它答”，哨兵负责“它主动报警”。
