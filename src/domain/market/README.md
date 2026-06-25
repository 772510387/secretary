# Market Domain

负责行情、指数、K 线、交易时段和交易日历的领域模型。

## 需要实现

- `StockSymbol`：已实现 A 股代码、市场、名称。
- `QuoteSnapshot`：已实现最新价、涨跌幅、成交额、时间戳。
- `IndexSnapshot`：已实现上证指数、深成指、创业板指、科创 50 的统一指数快照；指数只用于观察，不改变交易限制。
- `KlineBar`：已实现日 K 线统一结构。
- `KlineTechnicalIndicators`：已实现 MA5、MA10、MA20、60 日高低点、区间位置和基础趋势标签。
- `MarketSession`：盘前、集合竞价、上午、午休、下午、收盘、非交易。
- `TradingCalendar`：判断交易日和交易时段。
- `MarketAnomaly`：已覆盖指数急涨急跌、系统性风险、放量、量价齐升、爆量滞涨、低流动性和停牌/无量标签。

## 输入

- provider 返回的原始行情。
- 本地交易日历。
- 当前北京时间。

## 输出

- 标准化行情快照。
- 交易时段判断。
- 可供小脑和风控使用的市场信号。

## 当前接口

```ts
import {
  normalizeStockSymbol,
  quoteSnapshotSchema,
  toTencentQuoteSymbol,
} from "./src/domain/market/index.js";

const symbol = normalizeStockSymbol("000636");
const tencentCode = toTencentQuoteSymbol(symbol);
const quote = quoteSnapshotSchema.parse(input);
```

## KlineBar 和技术指标

```ts
import {
  calculateKlineTechnicalIndicators,
  klineBarSchema,
} from "./src/domain/market/index.js";

const bars = input.map((item) => klineBarSchema.parse(item));
const indicators = calculateKlineTechnicalIndicators(bars);
```

指标口径：

- `ma5` / `ma10` / `ma20`：按收盘价计算，样本不足时为 `undefined`。
- `high60` / `low60`：最近最多 60 根 K 线的高低点。
- `rangePosition60`：当前收盘价在最近最多 60 根 K 线区间的位置，范围 `0-1`。
- `trend`：`uptrend`、`downtrend`、`sideways`、`insufficient_data`。

## QuoteSnapshot 口径

- `latestPrice`：当前价。
- `previousClose`：昨收。
- `openPrice`：今开。
- `highPrice` / `lowPrice`：高低价，provider 有字段时提供。
- `changeAmount`：当前价减昨收。
- `changePct`：小数比例，不是百分数字符串。例如腾讯返回 `2.06`，系统保存为 `0.0206`。
- `volume`：provider 原始成交量字段转整数。
- `turnover`：provider 原始成交额字段。
- `providerTime`：provider 时间，标准化为 ISO。
- `receivedAt`：系统收到行情的时间。

## 验收

- 能正确识别主板代码。主板细分由 `PolicyEngine` 负责，market 当前负责 A 股市场归属。
- 能识别交易时段。
- 能把不同 provider 的行情转为统一结构。Tencent quote 已完成。
- 能把不同 provider 的指数快照转为统一结构。Tencent index 已完成，科创 50 固定 `tradingAllowed=false`。
- 能把不同 provider 的历史 K 线转为统一结构。Tencent history 已完成。
- 能对缺字段、停牌、无行情做安全处理。Tencent parser 会跳过无有效价格的行，provider 对空结果抛出明确错误。

## R6 指数和量价雷达

已新增 `IndexSnapshot`、`MarketAnomaly`、`calculateKlineVolumePriceSignal()` 和 `calculateQuoteVolumePriceSignal()`。

指数口径：

- 支持 `sse_composite`、`szse_component`、`chinext`、`star50`。
- 指数快照固定 `provider=tencent`，并固定 `tradingAllowed=false`。
- 科创 50 只作为指数观察，不代表允许交易科创板股票；主板限制仍由 `PolicyEngine` 负责。

量价口径：

- K 线和快照都只在 domain 层计算确定性标签，不联网、不调用 LLM、不生成订单。
- 标签包括 `volume_surge`、`volume_price_rise`、`volume_stagnation`、`low_liquidity`、`suspended_or_no_volume`、`insufficient_data` 和 `normal`。
- 输出只包含指标、标签和 metadata，metadata 固定标记 `brokerConnected=false`、`liveTrading=false`。
- `createLivePaperSentinelTask` 已接入 quote 成交量增量窗口：样本足够且触发 `volume_surge` / `volume_price_rise` / `volume_stagnation` / `suspended_or_no_volume` 时转换为通知；仍然只提示人工复核，不自动下单。

## R5-1 Watchlist

已新增 `watchlist_today`、`watchlist_long_term` 和 `potential_stocks` 三类自选池领域模型。

每条 `WatchlistEntry` 包含：

- `symbol`、`market`、`name`
- `priority`：`low`、`medium`、`high`
- `reason`、`source`、`updatedAt`
- 可选 `observePrice`，用于后续“接近观察价”扫描

`normalizeWatchlistEntry()` 会按 A 股代码推断 `market`，`buildWatchlistSnapshot()` 会生成纯领域 snapshot 并按标的去重。领域层不读写文件、不联网、不调用 LLM、不接 broker。落盘由 infrastructure storage 的 `WatchlistMemoryStore` 负责。
