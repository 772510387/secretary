# Providers Infrastructure

负责外部数据源和模型供应商适配。

## 需要实现

行情类：

- `TencentQuoteProvider`：已实现，支持单只、批量、mock fetch、默认跳过网络测试。
- `TencentHistoryProvider`：已实现，支持 A 股日 K 线、mock fetch、技术指标计算和默认跳过网络测试。
- `TencentIndexProvider`：已实现，支持上证指数、深成指、创业板指、科创 50 指数快照、mock fetch 和默认不联网测试。
- `TushareProvider`：已完成接入评估，后续只在 token、许可、频率和缓存策略明确后实现。
- `AkshareProvider`：已完成接入评估，后续可作为研发/数据探索补充源，默认只能 mock 或 fake subprocess 测试。

模型类：

- `MockBrainProvider`：已实现，稳定返回结构化 mock 输出，并强制校验。
- `DashScopeQwenProvider`：已实现，作为首个真实 provider，使用 OpenAI-compatible Chat Completions 和 JSON Mode，默认测试使用 mock fetch。
- `OpenAIProvider`：已实现，作为质量基准和复杂任务备选，使用官方 Chat Completions JSON Mode，默认测试使用 mock fetch。
- `GeminiProvider`：已完成结构化输出兼容性评估，当前暂缓实现，后续接入前必须先做 schema 收敛策略。

研究类：

- `TradingAgentsCnAdapter`：已实现最小版本，通过注入 runner 把外部输出转换为 `ResearchReport`。
- `TradingAgentsCnSubprocessRunner`：已实现 fake subprocess 集成测试版，作为首个外部 TradingAgents-CN runner 接入方式。

## 统一要求

- provider 返回 domain 定义的结构。
- 原始响应可以写入 debug cache，但不能污染领域层。
- 网络错误、限流、无数据要有明确错误类型。
- provider 必须可 mock，方便测试。

## P5 接入评估结论

真实 BrainProvider 接入顺序见 `docs/architecture/decision-records/2026-06-14-brain-provider-integration-evaluation.md`：

- 第一优先级：`DashScopeQwenProvider`。
- 第二优先级：`OpenAIProvider`。
- 第三优先级：`GeminiProvider`。

R8 后续评估：

- Gemini structured output 评估见 `docs/architecture/decision-records/2026-06-16-gemini-provider-structured-output-evaluation.md`。
- Tushare/AkShare provider 评估见 `docs/architecture/decision-records/2026-06-16-tushare-akshare-provider-evaluation.md`。

所有真实 BrainProvider 都必须满足：

- API key 只来自环境变量或本机密钥管理，不写入仓库。
- 模型不拥有可执行工具权限，`ToolPermission.canExecute` 保持 `false`。
- 输出先转候选对象，再经过 `brainOutputSchema` 和任务级 schema 校验。
- 明确处理缺 key、认证失败、限流、超时、服务错误、内容拦截、空响应和 schema 失败。
- 记录 provider、model、requestId、token usage 和估算费用等元数据，但不记录完整敏感 prompt 或密钥。

真实 TradingAgents-CN runner 接入方式见 `docs/architecture/decision-records/2026-06-14-tradingagents-cn-runner-integration-evaluation.md`：

- 第一阶段使用外部子进程 runner。
- 不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。
- 不接 broker，不传账户、订单、持仓或实盘密钥。
- 输入输出使用严格 JSON 协议，stdout 只承载最终结果或 `SECRETARY_RESULT_JSON:` 行。
- 超时后终止外部任务，失败时降级为 `degraded=true` 报告或抛出 `ResearchProviderError`。

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

## TencentHistoryProvider

```ts
import { TencentHistoryProvider } from "./src/infrastructure/providers/index.js";

const provider = new TencentHistoryProvider();
const bars = await provider.getDailyKlines("000636", { count: 60 });
const indicators = await provider.getDailyTechnicalIndicators("000636", { count: 60 });
```

默认 endpoint：

```text
https://web.ifzq.gtimg.cn/appstock/app/fqkline/get
```

实现细节：

- 使用 `toTencentQuoteSymbol()` 转换 `000636 -> sz000636`、`601187 -> sh601187`。
- 默认请求日线 `day`、最近 `60` 条、前复权 `qfq`。
- 优先读取腾讯响应中的 `qfqday`，没有时回退到 `day`。
- 日 K 行字段按 `[日期, 开盘, 收盘, 最高, 最低, 成交量, 成交额?]` 解析。
- 无效日期、缺字段、非数字价格或成交量会被跳过。
- 空响应或没有有效 K 线时抛出 `HistoryProviderError`。
- `getDailyTechnicalIndicators()` 使用领域层纯函数计算 MA5、MA10、MA20、60 日高低点、区间位置和趋势标签。

网络测试默认跳过。需要手动验证真实接口时：

```powershell
$env:TENCENT_HISTORY_NETWORK='1'
npm test -- tests/integration/tencent-history-provider.test.ts
Remove-Item Env:TENCENT_HISTORY_NETWORK
```

## TencentIndexProvider

```ts
import { TencentIndexProvider } from "./src/infrastructure/providers/index.js";

const provider = new TencentIndexProvider();
const sse = await provider.getIndex("sse_composite");
const indexes = await provider.getIndexes();
```

默认 endpoint：

```text
https://qt.gtimg.cn/q=
```

实现细节：

- 默认指数集合为上证指数 `sh000001`、深成指 `sz399001`、创业板指 `sz399006`、科创 50 `sh000688`。
- 输出统一转换为 `IndexSnapshot`，固定 `provider=tencent`。
- `star50` 只作为指数观察，快照固定 `tradingAllowed=false`，不改变主板交易限制。
- 支持注入 `fetchImpl` 和 `timeoutMs`，默认测试使用 mock fetch，不联网。
- HTTP 失败、空响应、坏数据和超时都会抛出 `IndexProviderError`。

当前没有默认真实网络 smoke；需要手动验证时应新增显式环境变量后再运行，不能让真实网络成为必跑测试。

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

## DashScopeQwenProvider

```ts
import { brainInputSchema } from "./src/domain/brain/index.js";
import { DashScopeQwenProvider } from "./src/infrastructure/providers/index.js";

const provider = new DashScopeQwenProvider({
  apiKey: process.env.DASHSCOPE_API_KEY,
  model: "qwen-plus",
});

const output = await provider.generate(
  brainInputSchema.parse({
    requestId: "brain-req-001",
    taskType: "pre_market_plan",
    prompt: "Build a pre-market plan and return BrainOutput JSON.",
  }),
);
```

实现细节：

- 默认 endpoint：`https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`。
- 默认模型：`qwen-plus`。
- 请求使用非流式 Chat Completions：`stream=false`。
- 请求使用 JSON Mode：`response_format={ "type": "json_object" }`。
- 不发送 `tools` 字段，不给模型任何工具执行能力。
- 输入先经过 `brainInputSchema`，`ToolPermission.canExecute=true` 会被本地拒绝。
- 模型返回内容先解析为候选 `BrainOutput`，再通过 `validateBrainOutput()` 和可选任务级 schema 校验。
- 覆盖缺 key、401/403、429、5xx、超时、空响应、坏 HTTP JSON、坏 message JSON 和坏 schema。

网络 smoke 默认跳过。需要手动验证真实接口时：
```powershell
$env:DASHSCOPE_BRAIN_NETWORK='1'
$env:DASHSCOPE_API_KEY='your-local-secret'
npm test -- tests/integration/dashscope-qwen-provider.test.ts
Remove-Item Env:DASHSCOPE_BRAIN_NETWORK
Remove-Item Env:DASHSCOPE_API_KEY
```

## OpenAIProvider

```ts
import { brainInputSchema } from "./src/domain/brain/index.js";
import { OpenAIProvider } from "./src/infrastructure/providers/index.js";

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL ?? "gpt-5.5",
});

const output = await provider.generate(
  brainInputSchema.parse({
    requestId: "brain-req-001",
    taskType: "pre_market_plan",
    prompt: "Build a pre-market plan and return BrainOutput JSON.",
  }),
);
```

实现细节：

- 默认 endpoint：`https://api.openai.com/v1/chat/completions`。
- 默认模型：`gpt-5.5`，可通过 `OPENAI_MODEL` 覆盖。
- 请求使用非流式 Chat Completions：`stream=false`。
- 请求使用 JSON Mode：`response_format={ "type": "json_object" }`。
- 可选输出长度使用 `max_completion_tokens`，不使用旧的 `max_tokens`。
- 请求固定 `store=false`，避免把开发阶段请求默认存储为训练/评估材料。
- 使用 `developer` 消息写入安全边界，不发送 `tools` 字段，不给模型任何工具执行能力。
- 输入先经过 `brainInputSchema`，`ToolPermission.canExecute=true` 会被本地拒绝且不会调用 fetch。
- 模型返回内容先解析为候选 `BrainOutput`，再通过 `validateBrainOutput()` 和可选任务级 schema 校验。
- 覆盖缺 key、401/403、429、5xx、超时、空响应、坏 HTTP JSON、坏 message JSON、坏 schema、任务级 Zod 校验和 provider 身份不匹配。

当前只有 mock fetch 单元测试，不提供默认真实网络 smoke。未来需要真实 smoke 时必须新增显式环境变量，例如 `OPENAI_BRAIN_NETWORK=1`，并只从本机环境读取 `OPENAI_API_KEY`。

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

## TradingAgentsCnSubprocessRunner

```ts
import {
  TradingAgentsCnAdapter,
  TradingAgentsCnSubprocessRunner,
} from "./src/infrastructure/providers/index.js";

const subprocessRunner = new TradingAgentsCnSubprocessRunner({
  command: "python",
  args: ["path/to/external_tradingagents_cn_runner.py"],
});

const adapter = new TradingAgentsCnAdapter({
  runner: subprocessRunner.run,
});

const report = await adapter.runResearch(researchTask);
```

实现细节：

- 当前实现只在测试中使用 fake subprocess，不导入、不复制 TradingAgents-CN 的 `app/` 或 `frontend/`。
- 子进程输入使用 `secretary.tradingagents-cn.runner.v1` JSON 协议，固定 `allowNetwork=false`、`allowBroker=false`、`allowOrders=false`。
- 请求只传研究任务和脱敏后的只读上下文；`account`、`positions`、`orders`、`broker` 和 secret-like 字段不会透传。
- stdout 支持严格 JSON 对象，或最终结果行 `SECRETARY_RESULT_JSON:{...}`。
- 协议包装输出会读取 `report` 字段，再交给 `TradingAgentsCnAdapter` 转换为安全 `ResearchReport`。
- 非零退出、空 stdout、坏 JSON、失败 status、请求 ID 不匹配和超时会抛出 `ResearchProviderError`；在 adapter 默认配置下会降级为 `degraded=true` 报告。
- 超时或外部 abort 会终止子进程；stderr 只进入脱敏后的错误摘要。
- 不调用真实 LLM，不联网，不接 broker，不写账户或订单。

fake subprocess 测试：

```powershell
npm test -- tests/integration/trading-agents-cn-subprocess-runner.test.ts
```
