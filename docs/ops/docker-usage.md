# Docker 使用说明

生成日期：2026-06-16

本文档沉淀 secretary 项目的日常 Docker 操作命令。所有命令在仓库根目录
`D:\Project\main\secretary` 下执行。

## 0. 这个容器实际跑的是什么（先读这一段）

- 本项目**没有 HTTP server / Web 服务 / 实盘交易进程**。
- `docker compose up` 默认启动的是**离线 mock 哨兵 daemon**
  (`scripts/dev/market-sentinel-daemon.ts`)。它只把调度审计元数据写进
  `memory/logs/`，**不联网、不调用大模型、不接券商、不读写真实账户**。
  daemon 输出里固定是 `brainProvider: "mock"`、`networkAllowed: false`、
  `liveTrading: false`，这是安全边界，不是配置没生效。
- 因此**容器启动不需要任何 API key**。DashScope / Gemini key 当前不会被任何
  启动路径调用（见 `.env` 说明）。

## 1. 环境前提

- Docker Engine ≥ 29，Docker Compose v2/v5。
- 验证：`docker version`、`docker compose version`。

## 2. 首次启动流程

```powershell
# 1. 构建镜像（首次或改了依赖/源码后）
docker compose build

# 2. 用一次性命令体检配置（确认 .env 被正确加载）
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/doctor.ts

# 3. 启动常驻 daemon（后台）
docker compose up -d

# 4. 查看运行状态和日志
docker compose ps
docker compose logs -f          # Ctrl+C 退出日志跟随，不会停容器

# 5. 优雅停止（发送 SIGTERM，daemon 会干净关闭）
docker compose stop

# 6. 停止并清理容器+网络（保留镜像和挂载的数据卷）
docker compose down
```

## 3. 日常命令速查

| 目的 | 命令 | 说明 |
| --- | --- | --- |
| 重新构建镜像 | `docker compose build` | 改了 `package.json` 或源码后执行 |
| 前台启动 | `docker compose up` | 日志直接打到终端，Ctrl+C 停止 |
| 后台启动 | `docker compose up -d` | detached，长期值守用这个 |
| 看状态 | `docker compose ps` | 确认 `STATUS` 是 `Up` |
| 跟随日志 | `docker compose logs -f` | `--no-log-prefix` 去掉服务名前缀 |
| 优雅停止 | `docker compose stop` | daemon 收到 SIGTERM 后清理调度器 |
| 停止+删容器 | `docker compose down` | 数据卷 `./memory`、`./data` 保留 |
| 进容器排查 | `docker compose exec secretary sh` | 容器在运行时进去看文件 |
| 重启 | `docker compose restart` | 不重建镜像 |

## 4. 一次性脚本（不进入常驻 daemon）

用 `docker compose run --rm secretary <命令>` 跑一次就退出，`--rm` 自动删除临时容器。
所有脚本入口都是 `./node_modules/.bin/tsx <脚本路径>`：

```powershell
# 配置体检
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/doctor.ts

# 初始化模拟账户（2 万元，写入挂载的 memory/portfolio）
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/seed-paper-account.ts

# 跑一次研究（当前是本地 mock runner，不连真实 TradingAgents-CN）
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/research-once.ts `
  --symbol 000636 --market SZSE --date 2026-06-16 --objective "生成一份安全研究报告"

# 人工确认提案 CLI
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/manual-confirm.ts

# 大脑 provider 冒烟：真正调用一次配置的 LLM，验证 DASHSCOPE_API_KEY 是否可用。
# 真实 provider 必须显式放行联网（BRAIN_NETWORK_SMOKE=1），否则脚本拒绝并退出 2。
docker compose run --rm -e BRAIN_NETWORK_SMOKE=1 secretary `
  ./node_modules/.bin/tsx scripts/dev/brain-smoke.ts


# daemon 定时冒烟（跑 1.5 秒自动停，把全天当作开盘）
docker compose run --rm secretary ./node_modules/.bin/tsx scripts/dev/market-sentinel-daemon.ts `
  --run-ms 1500 --allow-outside-session
```

> PowerShell 续行用反引号 `` ` ``；如果写成一行就不需要。

## 5. 数据与配置

- **配置注入**：`docker-compose.yml` 用 `env_file: .env` 把 `.env` 的所有
  `KEY=value` 注入容器环境变量。`loadConfig()` 读 `process.env`，所以 key
  不会被打进镜像层（更安全）。改了 `.env` 后**重启容器即可**，无需重建镜像。
- **数据持久化**：`./memory` 和 `./data` 以数据卷挂载进容器
  (`/app/memory`、`/app/data`)。审计日志、模拟账户、报告、研究结果在容器重启后保留。
- **时区**：容器 OS 时区设为 `Asia/Shanghai`，但业务时间由应用内部强制
  `Asia/Shanghai`，与宿主机/容器 OS 时区无关。

## 6. 常见问题

- **改了 .env 没生效**：`docker compose up -d` 会用新环境重建容器；若用的是
  `restart`，需要先 `down` 再 `up -d`。
- **端口冲突**：本项目不监听端口，无需映射 `ports`。
- **想真正调用大模型（Gemini 主 / DashScope 备）**：在 `.env` 配置
  `BRAIN_PROVIDER=gemini`、`BRAIN_FALLBACK_PROVIDER=dashscope`，填好 `GEMINI_API_KEY`
  和 `DASHSCOPE_API_KEY` 后，运行 `npm run brain:smoke`（或上面的 docker 版本，需
  `BRAIN_NETWORK_SMOKE=1`）发一次真实请求验证。Gemini 失败时会自动降级到 DashScope。
  `createBrainProvider(config.brain)` 工厂把 `BRAIN_PROVIDER`/`BRAIN_FALLBACK_PROVIDER`
  映射成 `FallbackBrainProvider` 链。**注意**：常驻 daemon 和报告生成仍按安全边界
  走 mock/离线，不会因为填了 key 就自动联网；只有 `brain:smoke` 会真正发请求。
