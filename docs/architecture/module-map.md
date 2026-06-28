# 模块地图

## 领域层

| 模块 | 路径 | 核心责任 |
| --- | --- | --- |
| Market | `src/domain/market` | 行情快照、K 线、指数、交易日历的领域模型 |
| Portfolio | `src/domain/portfolio` | 账户、现金、持仓、交易流水、可用数量 |
| Trading | `src/domain/trading` | 交易意图、订单生命周期、模拟成交 |
| Risk | `src/domain/risk` | 硬风控、仓位、止损、熔断、禁买 |
| Memory | `src/domain/memory` | 长期记忆结构、读写策略、写入提案 |
| Strategy | `src/domain/strategy` | 命名策略本体、strategy_id 归因和 regime 指纹匹配 |
| Cerebellum | `src/domain/cerebellum` | 小脑事件、闹钟、盘中哨兵触发条件 |
| Brain | `src/domain/brain` | LLM 抽象、输入输出协议、结构化建议 |
| Research | `src/domain/research` | 深度研究任务、TradingAgents-CN 适配结果 |
| Notification | `src/domain/notification` | 告警等级、通知内容、去重和冷却 |
| Audit | `src/domain/audit` | 审计事件、不可抵赖日志模型 |

## 基础设施层

| 模块 | 路径 | 核心责任 |
| --- | --- | --- |
| Storage | `src/infrastructure/storage` | JSON 原子写入、备份、未来 SQLite |
| Providers | `src/infrastructure/providers` | 行情、历史、新闻、LLM SDK 适配 |
| Scheduler | `src/infrastructure/scheduler` | 北京时间任务、交易时段、常驻任务 |
| Broker | `src/infrastructure/broker` | PaperBroker、ManualConfirmBroker、未来 QMT/PTrade |
| Logging | `src/infrastructure/logging` | 结构化日志、错误日志、审计落盘 |

## 入口层

| 模块 | 路径 | 核心责任 |
| --- | --- | --- |
| CLI | `src/interfaces/cli` | 本机命令、手动查询、运维命令 |
| API | `src/interfaces/api` | HTTP 服务、未来 UI 或外部调用 |
| Webhook | `src/interfaces/webhook` | 告警触发、聊天入口、外部事件 |

## 运行资产

| 目录 | 责任 |
| --- | --- |
| `config` | 非密钥配置模板 |
| `data/schemas` | JSON schema 和数据契约 |
| `data/seeds` | 初始账户、规则、自选池等种子数据 |
| `data/cache` | 可清理缓存 |
| `memory` | 可长期保留、可审计的系统记忆 |
