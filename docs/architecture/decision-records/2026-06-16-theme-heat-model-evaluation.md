# 题材热度确定性模型评估

## 背景

R5-3 需要先明确题材/板块热度如何计算，避免把 LLM 的叙述当成确定性市场事实。当前阶段不实现真实网络抓取，不接入外部题材数据源，也不让模型直接写规则、写自选池或生成订单。

## 决策

第一阶段把题材热度建模为确定性评分结果，后续由 provider 或手工导入的数据填充事实字段。LLM 只能解释评分、整理报告或提出人工复核提案，不能直接决定热度写入、规则变更或交易动作。

建议领域对象：

```ts
interface ThemeHeatSnapshot {
  themeId: string;
  name: string;
  observedAt: string;
  source: "manual_import" | "provider";
  score: number;
  rank?: number;
  components: {
    breadth: number;
    momentum: number;
    volume: number;
    newsCount?: number;
    limitUpCount?: number;
    leadingSymbolCount?: number;
  };
  symbols: Array<{
    symbol: string;
    market: "SSE" | "SZSE";
    name: string;
    role: "leader" | "member" | "watch";
    changePct?: number;
    turnoverRatio?: number;
    volumeRatio?: number;
  }>;
  metadata: Record<string, unknown>;
}
```

评分必须由代码计算，建议初始权重：

- `breadth`：题材内上涨股票占比、强势股票占比、创新高占比。
- `momentum`：题材内平均涨跌幅、中位涨跌幅、领涨股涨幅。
- `volume`：题材内相对成交量、成交额放大、换手率。
- `newsCount`：可选字段，只作为事实计数，不直接由 LLM 生成。
- `limitUpCount`：涨停数量或接近涨停数量。

`score` 归一化到 `0-100`。缺字段时只计算可用组件，并在 `metadata.missingFields` 标记缺口。不得因为 LLM 文字判断而补齐缺字段。

## 数据源

候选数据源按安全顺序：

1. 手工导入 CSV/JSON：第一阶段推荐，适合验证 schema、缓存和评分。
2. 已有 QuoteProvider/HistoryProvider：用于计算题材成分股的涨跌幅、成交额、量比和趋势。
3. 后续 Tushare/Akshare 或其他合法 provider：需要单独评估许可、字段映射、频率限制和缓存。
4. 新闻或公告源：只作为可选计数字段，不直接成为交易规则。

暂不使用 web search 自动生成题材池，也不自动把搜索结果落为交易候选。

## 缓存

建议路径：

- `data/cache/theme-heat/YYYY-MM-DD/{themeId}.json`：可清理缓存。
- `memory/market/themes/{YYYY-MM-DD}.json`：仅在人工确认或确定性任务批准后沉淀摘要。

缓存记录需要包含 `source`、`observedAt`、`provider`、`inputHash`、`fieldCoverage` 和 `missingFields`。缓存过期策略按交易日和数据源声明决定，默认盘中缓存 5-10 分钟，盘后快照可保留到当日结束。

## 失败降级

- 数据源失败：返回 `degraded=true`，保留可用组件和缺失字段，不制造热度结论。
- 字段缺失：该组件不参与加权，结果标记 `fieldCoverage`。
- 缓存过期：可返回上一次缓存，但必须标记 `stale=true` 和 `staleAsOf`。
- provider 限流：进入冷却，不重试刷屏，不唤醒 broker。
- schema 失败：拒绝写入缓存或记忆，只写 metadata-only 审计。

## LLM 边界

允许：

- 解释确定性热度分数。
- 对题材变化生成复盘报告。
- 提出需要人工复核的自选池调整提案。

禁止：

- 直接决定题材热度分数。
- 直接覆盖规则或风控阈值。
- 直接写入自选池最终版本。
- 直接生成订单、下单或绕过 `PolicyEngine`、`RiskEngine`、`AuditLog`。

## 影响

R5-3 只形成设计，不新增 provider，不联网，不写 token，不接 LLM，不接 broker。后续若进入实现，应先做 `ThemeHeatSnapshot` schema 和纯函数评分测试，再接入手工导入或 mock provider。

## 后续动作

- R5/R6 稳定后，新增 `ThemeHeatSnapshot` 领域模型和评分单元测试。
- 评估 Tushare/Akshare 等 provider 时补许可、字段、限流和缓存 ADR。
- 与 Watchlist 存储集成前，必须经过 `MemoryWritePolicy` 或人工提案路径。
