# Runtime Config

`src/config` 负责加载、合并、校验配置。

## 需要实现

- `loadConfig()` 从 `.env`、环境变量和 `config/default.example.json` 读取配置。
- `appConfigSchema` 使用 Zod 校验配置。
- `redactConfig()` 和 `getConfiguredSecrets()` 区分 secret 和 non-secret。
- `AppConfig` 提供强类型配置。
- `isLiveTradingEnabled()` 提供严格的实盘启用判断。

## 配置来源

- `.env`：密钥、运行态开关、本机路径。
- `config/default.example.json`：非敏感默认参数。
- CLI 参数：一次性覆盖项。

优先级从低到高：

1. `config/default.example.json`
2. `.env`
3. `process.env`
4. `loadConfig({ env })`
5. `loadConfig({ overrides })`

## 安全要求

- 密钥不写入日志。
- 实盘交易默认关闭。
- 没有显式配置时使用 mock brain 和 paper broker。

## 当前接口

```ts
import {
  getConfiguredSecrets,
  isLiveTradingEnabled,
  loadConfig,
  redactConfig,
} from "./src/config/index.js";

const config = loadConfig();
const safeConfig = redactConfig(config);
const liveEnabled = isLiveTradingEnabled(config);
const secrets = getConfiguredSecrets(config);
```

## 实盘开关规则

`LIVE_TRADING=true` 本身不足以开启实盘。

`isLiveTradingEnabled(config)` 只有在以下条件同时满足时才返回 `true`：

- `runtime.liveTrading === true`
- `trading.mode === "live"`
- `broker.provider` 不是 `paper` 或 `readonly`

这保证误填一个环境变量不会让系统进入真实交易模式。
