# 深度研判接入（TradingAgents-CN）

生成日期：2026-06-21

把 secretary 的 `deep_research` 意图接到 **TradingAgents-CN 多智能体分析引擎**：用户说
「深度分析 X / 该不该买卖 / 下周怎么操作」时，调度一支智能体团队（行情/基本面/消息面分析师
→ 多空辩论 → 交易员 → 风控经理）出一份完整研判，而不是一次性快问快答。

架构：secretary 不内嵌 Python。`deep_research` → `runResearchOnce` → 一个**子进程**桥接
（`secretary_bridge.py`）→ TradingAgents-CN 的 `TradingAgentsGraph.propagate` → 把结果映射回
secretary 的 `ResearchReport`。模型团队**只产出待人工复核的研判**：不下单、不写账户、不接券商。

## 两条红线没变

- 深度研判结论是**建议**，标了「需人工复核、不自动下单」；secretary 侧 `tradeIntentDrafts`
  仍是 `executable:false`。
- 子进程**只读取行情/基本面/消息数据**，不碰 broker、不写账户。

## 成本与速度

- 一次深度分析是**多智能体 + 多轮辩论**，要**数分钟**、耗一定 token。所以它是**显式触发的深度层**，
  不是每条消息都跑。快层（看盘/问答）仍是秒级。
- 分析师越多越慢。`RESEARCH_ANALYSTS` 控制（如只 `market` 最快；`market,fundamentals,news` 更全）。

## 一次性安装（TradingAgents-CN 仓库）

```powershell
cd D:\Project\main\TradingAgents-CN
uv sync                 # 建 .venv(Python 3.10) —— 若 qianfan 解析报错，改用下一行
uv pip install --python .venv/Scripts/python.exe -r requirements.txt
```

桥接脚本 `secretary_bridge.py` 已放在该仓库根目录（读 stdin 请求 → 跑 propagate →
打印一行 `SECRETARY_RESULT_JSON:{...}`）。

## 在 secretary 的 `.env` 开启

```env
RESEARCH_PROVIDER=trading_agents_cn
RESEARCH_COMMAND=D:/Project/main/TradingAgents-CN/.venv/Scripts/python.exe
RESEARCH_SCRIPT=D:/Project/main/TradingAgents-CN/secretary_bridge.py
RESEARCH_CWD=D:/Project/main/TradingAgents-CN
RESEARCH_TIMEOUT_MS=600000
RESEARCH_DEEP_MODEL=qwen-plus
RESEARCH_QUICK_MODEL=qwen-turbo
RESEARCH_ANALYSTS=market,fundamentals,news
```

复用你已有的 `DASHSCOPE_API_KEY`（LLM + `text-embedding-v3` 都走它）。子进程的环境由 secretary
的 factory 注入，**无需**在 TradingAgents-CN 单独配 `.env`：会自动带上 `DASHSCOPE_API_KEY`、
`ONLINE_TOOLS_ENABLED=true`、`PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python`（绕开 chromadb 的
protobuf 冲突）、`PYTHONUTF8=1`（绕开 Windows GBK 控制台编码）和 `SECRETARY_TA_*` 模型/分析师配置。

## 验证

```powershell
# 直连跑一次（不经飞书），约数分钟：
$env:RESEARCH_ANALYSTS="market"   # 先用单分析师快验
npm run research:smoke
```

看到 `provider: trading_agents_cn | conclusion: ... | degraded: false` 即接通。之后在飞书里
说「帮我分析一下下周怎么操作」，会先收到「🧠 已派多智能体分析团队…约需几分钟」，再收到完整研判。

## 排错

- `degraded: true` + `String must contain at most N characters`：某字段超出 secretary schema 限长；
  桥接已对各字段截断，若仍出现，调小 `secretary_bridge.py` 里的 `MAX_*`。
- `Descriptors cannot be created directly`（protobuf）：确认子进程带了
  `PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python`（factory 已自动注入）。
- `UnicodeEncodeError: 'gbk'`：确认 `PYTHONUTF8=1`（factory 已自动注入）。
- 超时：分析师太多/网络慢，调大 `RESEARCH_TIMEOUT_MS` 或减少 `RESEARCH_ANALYSTS`。
- `uv run` 报 `qianfan` 解析失败：那是可选 extra 的锅；直接用 `.venv/Scripts/python.exe`，别用 `uv run`。
