# Tushare/AkShare provider 接入评估

## 背景

R8-3 要评估是否补充市场、财务和板块数据 provider。当前系统已经有 TencentQuoteProvider、TencentHistoryProvider 和 TencentIndexProvider，能支撑 A 股行情、日 K 和指数快照的基础闭环。补充 Tushare/AkShare 的目标不是替代现有确定性规则，而是为后续题材热度、财务摘要、板块雷达和更完整的数据回补提供可选来源。

本次只做评估，不实现 provider，不写 token，不联网跑测试。

参考资料：

- https://tushare.pro/document/1?doc_id=40
- https://tushare.pro/document/1?doc_id=290
- https://akshare.akfamily.xyz/
- https://akshare.akfamily.xyz/data/stock/stock.html
- https://akshare.akfamily.xyz/data/index/index.html

## 外部事实

Tushare Pro 支持 Python SDK 和 HTTP POST 调用。HTTP 请求使用 `api_name`、`token`、`params` 和 `fields`，响应通过 `fields` 与 `items` 对齐返回。Tushare 文档也明确了 token 前置条件、权限返回码，以及积分/独立权限对应的分钟频次和每日调用量限制。

AKShare 是 Python 财经数据接口库，文档覆盖股票、指数、基金、宏观、另类数据等大量数据字典。股票数据包含 A 股实时行情、历史行情、行业比较、公告、机构调研等入口；指数数据也有独立文档。AKShare 适合作为本地 Python 子进程或独立 HTTP sidecar 的数据补充层，但其底层公共数据源稳定性、许可和频次边界需要按具体接口逐项确认。

## 决策

当前不实现 `TushareProvider` 或 `AkShareProvider`。

后续如果进入实现阶段，优先级如下：

1. `TushareProvider`：优先用于有明确 token、积分权限和使用许可的数据，尤其是日线、基础资料、财务指标、指数和行业/概念类回补。
2. `AkShareProvider`：作为研发和数据探索的可选补充，默认通过 fake subprocess 或 mock HTTP sidecar 测试，不作为生产级唯一数据源。
3. 现有 Tencent provider 保持为实时行情、历史 K 线和指数快照的默认依赖。

## 字段映射

Tushare 候选映射：

- `daily`、`adj_factor`、`daily_basic`：映射到 `KlineBar`、复权信息和量价指标输入。
- `stock_basic`：映射到股票基础资料、名称、上市状态和市场分区。
- `index_daily`、指数成分接口：映射到 `IndexSnapshot`、指数历史和板块/指数观察。
- `income`、`balancesheet`、`cashflow`、`fina_indicator`：映射到未来财务摘要 metadata，不进入交易执行链。
- 行业、概念、新闻或研报类接口：仅作为题材热度输入证据，不允许直接写规则或下单。

AKShare 候选映射：

- A 股实时行情、历史行情：映射到 `QuoteSnapshot` 或 `KlineBar` 的补充来源。
- 指数实时/历史数据：映射到 `IndexSnapshot` 或指数历史窗口。
- 板块、概念、行业、资金流向接口：映射到题材热度、观察池和雷达候选输入。
- 财务、公告、机构调研接口：映射到报告上下文 metadata，不写账户、不生成订单。

## 许可和频率

Tushare：

- token 只能来自环境变量或本机密钥管理，不写入仓库。
- 每个接口必须记录所需积分、独立权限、每分钟频次和每日上限。
- 公司或生产使用前必须确认授权范围；不能把个人权限默认扩展到商用或多人服务。
- provider 应内置节流、短期熔断和缓存键，不允许因为 429 或权限错误反复重试。

AKShare：

- 需要逐接口确认上游数据源许可和使用限制。
- 默认只作为研究/开发补充源，不承诺实时性、完整性或长期稳定字段。
- 必须限制并发和频率，避免对公共数据源造成压力。
- 若使用 Python 子进程，stderr 和异常必须脱敏，不能泄露 token、路径中的账号信息或完整请求正文。

## 缓存策略

- 日线、指数日线和财务数据按 `provider:endpoint:symbol:tradeDate:adjust` 维度缓存。
- 当日盘中数据设置短 TTL；财务和基础资料设置日级或版本级 TTL。
- 缓存只保存标准化后的 domain 对象或脱敏原始摘要，不保存 token。
- 缓存 miss 或 provider 失败时优先降级到现有 Tencent provider、上一次缓存或跳过该非关键输入。

## 失败降级

- 缺 token、权限不足、限流、HTTP 失败、坏 JSON、字段缺失、schema 不匹配和超时都必须返回清晰 provider error。
- 数据补充失败不得阻断 PolicyEngine、RiskEngine、AuditLog 或 broker 边界。
- 财务、板块和题材输入失败时，只生成“数据不足”的报告 metadata 或通知，不制造确定性结论。
- 不允许 provider 失败后让 LLM 猜测财务指标、板块热度或持仓信息。

## 测试策略

如果后续实现：

- 默认测试全部使用 mock fetch、fake subprocess 或本地 fixtures，不联网。
- 真实 smoke 必须用显式环境变量，例如 `TUSHARE_NETWORK=1` 或 `AKSHARE_NETWORK=1`。
- 不在测试或文档中写真实 token。
- 覆盖权限不足、限流、空响应、坏字段、超时、缓存命中和失败降级。

## 后续动作

- 暂缓 `TushareProvider` 和 `AkShareProvider` 实现。
- 若优先补财务和基础资料，先做 `TushareProvider` 的窄接口 contract。
- 若优先补题材探索，先做 `AkShareProvider` 的 fake subprocess contract，并明确每个接口的上游许可。
- 不改变主板交易限制，不接 broker，不让 LLM 因新增数据源获得工具执行权限。
