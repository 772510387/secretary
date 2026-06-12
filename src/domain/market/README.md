# Market Domain

负责行情、指数、K 线、交易时段和交易日历的领域模型。

## 需要实现

- `StockSymbol`：已实现 A 股代码、市场、名称。
- `QuoteSnapshot`：已实现最新价、涨跌幅、成交额、时间戳。
- `IndexSnapshot`：上证、深成指、创业板等指数快照。
- `KLine`：日线/分钟线。
- `MarketSession`：盘前、集合竞价、上午、午休、下午、收盘、非交易。
- `TradingCalendar`：判断交易日和交易时段。
- `MarketAnomaly`：急涨、急跌、破位、突破、放量。

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
- 能对缺字段、停牌、无行情做安全处理。Tencent parser 会跳过无有效价格的行，provider 对空结果抛出明确错误。
