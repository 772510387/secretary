import { pathToFileURL } from "node:url";
import { ConfigLoadError, loadConfig } from "../../src/config/index.js";
import { DailyBudget, createMarketSentinelDaemon } from "../../src/runtime/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  buildLivePaperSentinelTask,
  buildSilentPatrolDaemonTask,
} from "./market-sentinel-daemon.js";
import {
  buildCerebellumDeps,
  startCerebellumAlarmScheduler,
} from "./cerebellum-daemon.js";
import { buildDaemonNotifiers } from "./push-notifiers.js";
import { main as startFeishuBot } from "./feishu-bot.js";
import { ensureMemoryLayout } from "../../src/app/index.js";

/**
 * Secretary 全天候值守 — one resident process that runs all three at once:
 *   1. 飞书对话（你问它答）
 *   2. 盘中哨兵（3 秒级盯盘，异动唤醒大脑出 AI 研判）
 *   3. 闹钟矩阵（到点用真实数据跑 SOP → 大脑研判 → 推送；deep_review 走 TradingAgents-CN）
 *
 * Everything stays read-only: the model never trades, writes the account, or
 * touches a real broker. External push is opt-in (Feishu, FEISHU_NOTIFY=1).
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const memoryDir = config.storage.memoryDir;
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  // External push channel: Feishu (opt-in, FEISHU_NOTIFY=1).
  const notifiers = await buildDaemonNotifiers(config);
  // One budget shared by the sentinel + alarm/research so the whole process
  // respects a single per-day spend cap.
  const budget = new DailyBudget({
    brain: config.budget.brainDailyLimit,
    research: config.budget.researchDailyLimit,
    search: config.budget.searchDailyLimit,
  });

  // Crash-safety: a stray rejection/throw in ONE module (e.g. a chat-handler bug)
  // must not kill the process and silence the trading-critical sentinel.
  installGlobalSafetyHandlers();

  console.log("Secretary 全天候值守启动中……");

  // 资产整理: ensure the memory layout (rules/long_term/daily_logs/reviews/history/…) + MEMORY_INDEX.
  try {
    const layout = ensureMemoryLayout({ memoryDir });
    if (layout.created.length > 0 || layout.indexWritten) {
      console.log(`记忆库布局已就绪（新建 ${layout.created.length} 个目录${layout.indexWritten ? " + MEMORY_INDEX" : ""}）。`);
    }
  } catch (error) {
    console.error(`记忆库布局初始化失败（不影响值守）：${error instanceof Error ? error.message : String(error)}`);
  }

  // 1. 飞书对话通道（已配置才起）
  if (config.feishu.appId && config.feishu.appSecret) {
    try {
      await startFeishuBot();
    } catch (error) {
      console.error(
        `飞书聊天通道启动失败，继续值守其余模块：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    console.log("未配置飞书（FEISHU_APP_ID/SECRET），跳过聊天通道。");
  }

  // 2. 盘中哨兵（盯盘 + 异动唤醒大脑）
  const sentinelTask = buildLivePaperSentinelTask(memoryDir, notifiers, config, brainProvider, budget);
  const sentinelDaemon = createMarketSentinelDaemon({
    memoryDir,
    intervalMs: config.market.sentinelIntervalMs,
    task: sentinelTask,
  });
  sentinelDaemon.start();
  console.log(
    `盘中哨兵已启动（交易时段每 ${config.market.sentinelIntervalMs}ms 盯盘，异动唤醒大脑=${
      config.brain.provider !== "mock" ? "开" : "mock"
    }）。`,
  );

  // 3. 闹钟矩阵调度
  const cerebellum = startCerebellumAlarmScheduler(buildCerebellumDeps(config, budget, notifiers));
  console.log(
    `闹钟矩阵调度已启动（到点出研判并推送${config.research.provider === "trading_agents_cn" ? "，deep_review 走多智能体深度研究" : ""}）。`,
  );

  // 4. 链式静默巡航（盘中每 10 分钟脉冲：平稳只打 [PULSE] 静默日志、不耗 token；异动才唤醒大脑/推送）。
  const patrolTask = buildSilentPatrolDaemonTask(memoryDir, notifiers, config, undefined, brainProvider, budget);
  const patrolTimer = setInterval(() => {
    void patrolTask();
  }, 20_000);
  patrolTimer.unref?.();
  console.log("链式静默巡航已启动（盘中每 10 分钟：平稳静默、异动唤醒）。");

  console.log("✅ 全天候值守已就绪：飞书对话 + 盘中哨兵 + 闹钟矩阵 + 链式静默巡航。Ctrl+C 退出。");

  const reason = await waitForShutdownSignal();
  console.log(`收到 ${reason}，正在停止……`);
  cerebellum.stop();
  clearInterval(patrolTimer);
  await sentinelDaemon.stop(reason);
  console.log("已停止。");
  process.exit(0);
}

let safetyHandlersInstalled = false;

/**
 * Keep the resident process alive through a stray async failure in any one module.
 * Without this, an unhandledRejection (e.g. a bug in the Feishu handler) would
 * crash the process and silently take down the sentinel's stop-loss alerts. We log
 * loudly and keep running; a real fatal config error still exits via main().catch.
 */
function installGlobalSafetyHandlers(): void {
  if (safetyHandlersInstalled) {
    return;
  }
  safetyHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    console.error(
      `[unhandledRejection] 已捕获并继续值守：${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  });
  process.on("uncaughtException", (error) => {
    console.error(`[uncaughtException] 已捕获并继续值守：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
}

function waitForShutdownSignal(): Promise<string> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const onSigint = (): void => {
      cleanup();
      resolve("SIGINT");
    };
    const onSigterm = (): void => {
      cleanup();
      resolve("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  });
}
