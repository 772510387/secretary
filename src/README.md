# Source

`src` 存放未来 TypeScript 源码。

## 分层

- `domain/`：纯领域规则和数据模型。
- `app/`：用例编排。
- `infrastructure/`：外部系统适配。
- `interfaces/`：用户和外部入口。
- `runtime/`：启动、装配和生命周期。
- `config/`：配置加载和校验。

## 依赖方向

```text
interfaces -> app -> domain
runtime -> interfaces/app/infrastructure/config
infrastructure -> domain
domain -> no infrastructure
```

`domain` 不能依赖：

- 文件系统。
- HTTP client。
- OpenAI/Gemini/DashScope Qwen SDK 或 OpenAI-compatible 客户端。
- 券商 SDK。
- 数据库 SDK。
- 定时器实现。
