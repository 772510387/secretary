# 个人微信双向助手(wechaty)

生成日期：2026-06-17

把"你在微信里发消息 → secretary 执行/回复"接通。架构与 OpenClaw 一致:微信通道
适配器 → 归一化 → `runAgentTurn`(同一个指令大脑)→ 回复发回。本仓库**不内置 wechaty
依赖**,你要用时再装;`npm run wechat:bot` 会动态加载。

## 能做什么

- 杂项问答(读真实模拟盘 DB + 实时行情 → 模型回答,可联网检索)
- 自然语言指令:清库重置、构建账户(危险操作需**对话式二次确认**)
- 问项目能力与流程

只支持**个人微信私聊**(群聊不支持,和底层 puppet 能力一致)。

## 安全模型

- **owner 白名单**(`WECHAT_ALLOWED_USERS`):列出你自己的微信 id/昵称。
  - 白名单为空:任何人都能问答(只读),但**清库/建账户被禁用**。
  - 白名单非空:只有名单内的人能下危险指令。
- **危险操作走对话确认**:微信里没有 `--yes`,所以发"清除模拟盘数据"后,机器人会要求你
  回复『确认』才执行,回复『取消』放弃。
- 红线不变:**不接真实券商、不自动实盘、模型不能执行任何工具**。

## 上手步骤

1. 装 wechaty + 一个 puppet(选其一):
   - Windows 本地 hook(免费,需特定版本 PC 微信):`npm i wechaty wechaty-puppet-wcferry`
   - iPad 协议(稳定,需付费 token):`npm i wechaty wechaty-puppet-padlocal`
2. 在 `.env` 配置:
   ```env
   WECHATY_PUPPET=wechaty-puppet-wcferry
   WECHATY_PUPPET_TOKEN=          # padlocal 才需要
   WECHAT_ALLOWED_USERS=你的微信昵称或id
   ```
3. 启动并扫码(建议用**小号**,降低封号风险):
   ```powershell
   npm run wechat:bot
   ```
   终端会打印二维码链接,用微信扫码登录。之后给这个号发私聊消息即可对话。

## 诚实提醒

- **个人微信 hook/协议违反微信 ToS,账号有被限制/封禁风险**——这是所有个人微信机器人
  (含 OpenClaw 那条路)的共性。建议用小号、低频。要完全合规请改走企业微信自建应用 +
  公网回调(另一条路线)。
- puppet 对 PC 微信版本敏感,wcferry 需要匹配的微信客户端版本;具体见各 puppet 文档。
- 本机在 Clash 代理后:`wechat:bot` 脚本已带 `NODE_USE_ENV_PROXY=1`;微信流量为国内直连,
  Clash 一般直连放行。
