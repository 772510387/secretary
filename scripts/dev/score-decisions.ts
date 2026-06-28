import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigLoadError, loadConfig } from "../../src/config/index.js";
import { runReplay } from "../../src/runtime/index.js";
import {
  ForwardOutcomeReader,
  deterministicReplayDecider,
  distillSoftExperience,
  proposeRuleChangesFromExperience,
  resolveTrailingDecisionWindow,
  scoreReplaySnapshots,
} from "../../src/app/index.js";
import {
  FixtureHistoryProvider,
  TencentHistoryProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  DecisionMemoryStore,
  ExperienceMemoryStore,
  RuleProposalMemoryStore,
  createPortfolioMemoryPaths,
} from "../../src/infrastructure/storage/index.js";
import {
  accountSchema,
  pointInTimeSnapshotSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import type { KlineBar } from "../../src/domain/market/index.js";

interface ScoreCli {
  memoryDir?: string;
  windowDays: number;
  settleLag: number;
  horizon: number;
  threshold: number;
}

/**
 * Daily "score & persist" entry (F2a). Runs a TRAILING-window point-in-time replay,
 * scores each as-of decision against the realised forward outcome, and persists the
 * scored decisions to `memory/decisions/<date>/` — the data source the strategy
 * knowledge bridge (get_strategy_knowledge) and evening consolidation read but that
 * nothing currently writes outside the manual backtest. READ-ONLY: deterministic
 * decider, no model call, no order, no account write.
 *
 * Cron-friendly: window is computed automatically (trailing settled trading days),
 * so it can run unattended, e.g. nightly after close. Usage:
 *   tsx scripts/dev/score-decisions.ts [--window-days 10] [--settle-lag 6] [--horizon 5]
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const cli = parseArgs(process.argv.slice(2));
  const memoryDir = cli.memoryDir ?? config.storage.memoryDir;
  const paths = createPortfolioMemoryPaths(memoryDir);
  const account = readAccount(paths.accountPath);
  const positions = readPositions(paths.positionsPath);

  if (!account) {
    console.error("未找到模拟盘账户，请先建账户（npm run agent 里建模拟盘）。");
    process.exitCode = 1;
    return;
  }

  const window = resolveTrailingDecisionWindow({
    windowTradingDays: cli.windowDays,
    settleLagTradingDays: cli.settleLag,
  });

  console.log(
    `📊 决策评分落库（只读：确定性决策器、不调用模型、不下单、不写账户）：${window.from} → ${window.to}`,
  );
  console.log(
    `（前瞻 ${cli.horizon} 个交易日，结算滞后 ${cli.settleLag} 个交易日以保证前瞻数据已实现）`,
  );

  if (positions.length === 0) {
    console.log("当前无持仓，暂无可评分的持仓判断；decisions 不会更新。");
    return;
  }

  const provider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const barsBySymbol: Record<string, KlineBar[]> = {};
  for (const position of dedupeBySymbol(positions)) {
    try {
      barsBySymbol[position.symbol] = await provider.getDailyKlines(
        { symbol: position.symbol, market: position.market, name: position.name },
        { endDate: window.to, count: 240 },
      );
    } catch (error) {
      console.error(
        `(${position.symbol} 历史拉取失败，评分中将降级处理：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const historyProvider = new FixtureHistoryProvider(barsBySymbol);

  const report = await runReplay({
    startDate: window.from,
    endDate: window.to,
    account,
    positions,
    historyProvider,
    memoryDir,
    reason: "daily_close",
    historyCount: 60,
  });

  if (report.snapshots.length === 0) {
    console.log("窗口内没有可重放的时点快照（可能是节假日或数据缺失）；decisions 不会更新。");
    return;
  }

  const snapshots = report.snapshots.map((record) =>
    pointInTimeSnapshotSchema.parse(JSON.parse(readFileSync(record.filePath, "utf8"))),
  );

  const scoreResult = await scoreReplaySnapshots({
    snapshots,
    decider: deterministicReplayDecider,
    forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(barsBySymbol)),
    startDate: window.from,
    endDate: window.to,
    horizonTradingDays: cli.horizon,
    returnThreshold: cli.threshold,
    store: new DecisionMemoryStore({ memoryDir }),
  });

  console.log(
    `✅ 决策已落库：${memoryDir}/decisions/<日期>/<decisionId>.json（决策 ${scoreResult.scorecard.decisionsCount} 个，可评估 ${scoreResult.scorecard.scoredStances} 个）`,
  );

  // Distill the freshly scored decisions into SOFT experience + review-required proposals.
  const experience = distillSoftExperience({
    scored: scoreResult.scored,
    startDate: window.from,
    endDate: window.to,
    horizonTradingDays: cli.horizon,
    returnThreshold: cli.threshold,
  });
  new ExperienceMemoryStore({ memoryDir }).writeReport(experience);

  const proposals = proposeRuleChangesFromExperience({ report: experience });
  if (proposals.length > 0) {
    const proposalStore = new RuleProposalMemoryStore({ memoryDir });
    for (const proposal of proposals) {
      proposalStore.writeProposal(proposal);
    }
    console.log(`📋 硬规则变更提案 ${proposals.length} 条（status=pending_human_review，绝不自动生效）。`);
  }

  console.log("策略知识库现在可从 get_strategy_knowledge 读取这些已评分决策。");
}

function parseArgs(argv: string[]): ScoreCli {
  const result: ScoreCli = { windowDays: 10, settleLag: 6, horizon: 5, threshold: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ScoreCliError(`${arg} 需要一个值`);
      }
      i += 1;
      return value;
    };
    if (arg === "--memory-dir") {
      result.memoryDir = next();
    } else if (arg === "--window-days") {
      result.windowDays = Number(next());
    } else if (arg === "--settle-lag") {
      result.settleLag = Number(next());
    } else if (arg === "--horizon") {
      result.horizon = Number(next());
    } else if (arg === "--threshold") {
      result.threshold = Number(next());
    } else {
      throw new ScoreCliError(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(result.windowDays) || result.windowDays <= 0) {
    throw new ScoreCliError("--window-days 必须是正整数");
  }
  if (!Number.isInteger(result.settleLag) || result.settleLag <= result.horizon) {
    throw new ScoreCliError("--settle-lag 必须是大于 --horizon 的整数（保证前瞻数据已实现）");
  }
  if (!Number.isInteger(result.horizon) || result.horizon <= 0) {
    throw new ScoreCliError("--horizon 必须是正整数");
  }
  if (!Number.isFinite(result.threshold) || result.threshold < 0) {
    throw new ScoreCliError("--threshold 必须是非负数");
  }
  return result;
}

function dedupeBySymbol(positions: Position[]): Position[] {
  const seen = new Set<string>();
  const unique: Position[] = [];
  for (const position of positions) {
    if (!seen.has(position.symbol)) {
      seen.add(position.symbol);
      unique.push(position);
    }
  }
  return unique;
}

function readAccount(accountPath: string): Account | undefined {
  try {
    return accountSchema.parse(JSON.parse(readFileSync(accountPath, "utf8")));
  } catch {
    return undefined;
  }
}

function readPositions(positionsPath: string): Position[] {
  try {
    return positionSchema.array().parse(JSON.parse(readFileSync(positionsPath, "utf8")));
  } catch {
    return [];
  }
}

class ScoreCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScoreCliError";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof ScoreCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
