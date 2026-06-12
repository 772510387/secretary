# Providers Infrastructure

负责外部数据源和模型供应商适配。

## 需要实现

行情类：

- `TencentQuoteProvider`：已实现，支持单只、批量、mock fetch、默认跳过网络测试。
- `TencentHistoryProvider`
- `TushareProvider`，后续可选。
- `AkshareProvider`，后续可选。

模型类：

- `MockBrainProvider`：已实现，稳定返回结构化 mock 输出，并强制校验。
- `OpenAIProvider`：待实现。
- `GeminiProvider`：待实现。
- `DashScopeQwenProvider`：待实现，使用 OpenAI-compatible 地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

研究类：

- `TradingAgentsCnAdapter`：已实现最小版本，通过注入 runner 把外部输出转换为 `ResearchReport`。

## 统一要求

- provider 返回 domain 定义的结构。
- 原始响应可以写入 debug cache，但不能污染领域层。
- 网络错误、限流、无数据要有明确错误类型。
- provider 必须可 mock，方便测试。

## TencentQuoteProvider

```ts
import { TencentQuoteProvider } from "./src/infrastructure/providers/index.js";

const provider = new TencentQuoteProvider();
const quote = await provider.getQuote("000636");
const quotes = await provider.getQuotes(["000636", "sh601187"]);
```

默认 endpoint：

```text
https://qt.gtimg.cn/q=
```

实现细节：

- 使用 `toTencentQuoteSymbol()` 转换 `000636 -> sz000636`、`601187 -> sh601187`。
- 腾讯 `parts[2]` 解析为代码。
- 腾讯 `parts[3]` 解析为当前价。
- 腾讯 `parts[4]` 解析为昨收。
- 腾讯 `parts[5]` 解析为今开。
- 腾讯 `parts[30]` 解析为 provider 时间。
- 腾讯 `parts[32]` 解析为涨跌幅百分数，并转换为小数比例。
- 腾讯 `parts[33]`、`parts[34]`、`parts[37]` 分别尝试解析高价、低价、成交额。

网络测试默认跳过。需要手动验证真实接口时：

```powershell
$env:TENCENT_QUOTE_NETWORK='1'
npm test -- tests/integration/tencent-quote-provider.test.ts
```

## MockBrainProvider

```ts
import { brainInputSchema } from "./src/domain/brain/index.js";
import { MockBrainProvider } from "./src/infrastructure/providers/index.js";

const provider = new MockBrainProvider();
const input = brainInputSchema.parse({
  requestId: "brain-req-001",
  taskType: "pre_market_plan",
  prompt: "Build a pre-market plan.",
});

const output = await provider.generate(input);
```

实现细节：

- 不调用真实模型 API。
- 默认返回 `provider=mock`、`model=mock-brain-v1`。
- 输出会经过 `brainOutputSchema` 校验。
- 可通过 `structuredOutputSchema` 对 `structured` 字段做更细校验。
- `requireBrainProviderApiKey()` 已提供真实 provider 接入前的密钥缺失错误。

## TradingAgentsCnAdapter

```ts
import {
  TradingAgentsCnAdapter,
} from "./src/infrastructure/providers/index.js";

const adapter = new TradingAgentsCnAdapter({
  runner: async (task, { signal }) => {
    return externalTradingAgentsCnResearch(task, { signal });
  },
});

const report = await adapter.runResearch(researchTask);
```

实现细节：

- 当前不导入、不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。
- 通过注入的 `runner` 连接未来真实研究流程。
- 输出只返回 `ResearchReport`。
- 外部返回里的 `orders`、`execution` 等字段只会记录为 ignored metadata，不会进入订单链路。
- 默认超时 `30000ms`，错误或超时会返回 `degraded=true` 的降级报告。
- 设置 `fallbackOnError=false` 时会抛出 `ResearchProviderError`。
