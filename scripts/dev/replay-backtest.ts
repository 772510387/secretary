import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigLoadError, loadConfig } from "../../src/config/index.js";
import { runReplay, runWalkForward } from "../../src/runtime/index.js";
import {
  ForwardOutcomeReader,
  ModelReplayDecider,
  computeEquityCurve,
  deterministicReplayDecider,
  distillSoftExperience,
  proposeRuleChangesFromExperience,
  scoreReplaySnapshots,
} from "../../src/app/index.js";
import {
  FixtureHistoryProvider,
  MockBrainProvider,
  TencentHistoryProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  DecisionMemoryStore,
  ExperienceMemoryStore,
  JsonStore,
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
import {
  softExperienceReportSchema,
  walkForwardReportSchema,
  type EquityCurve,
  type ReplayScorecard,
  type SoftExperienceReport,
  type WalkForwardReport,
} from "../../src/domain/decision/index.js";
import type { KlineBar } from "../../src/domain/market/index.js";

interface ReplayCli {
  from: string;
  to: string;
  memoryDir?: string;
  historyCount: number;
  score: boolean;
  horizon: number;
  threshold: number;
  model: boolean;
  experiencePath?: string;
  walkForward: boolean;
  windowDays: number;
}

/**
 * Point-in-time replay backtest (P0). Replays a historical Beijing date range over
 * the alarm matrix, building a no-look-ahead snapshot at each node. READ-ONLY: it
 * never calls a model, places an order, or writes the account.
 *
 * To stay rate-limit-safe, each held symbol's full daily history is fetched ONCE
 * up front, then the replay reads as-of slices from that in-memory series — so the
 * per-node loop makes zero extra network calls. Even if the upstream ignores the
 * end-date, the as-of reader defensively re-filters to bars <= the simulated date.
 *
 * Usage: tsx scripts/dev/replay-backtest.ts --from 2026-06-15 --to 2026-06-19 [--memory-dir DIR] [--history-count 60]
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
    return;
  }

  console.log(`📼 时点重放（只读：不调用模型、不下单、不写账户）：${cli.from} → ${cli.to}`);

  const provider = new TencentHistoryProvider({ timeoutMs: config.market.quoteTimeoutMs });
  const barsBySymbol: Record<string, KlineBar[]> = {};
  for (const position of dedupeBySymbol(positions)) {
    try {
      barsBySymbol[position.symbol] = await provider.getDailyKlines(
        { symbol: position.symbol, market: position.market, name: position.name },
        { endDate: cli.to, count: 240 },
      );
    } catch (error) {
      console.error(
        `(${position.symbol} 历史拉取失败，重放中将降级处理：${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const historyProvider = new FixtureHistoryProvider(barsBySymbol);

  if (cli.walkForward) {
    await runWalkForwardCli(cli, config, memoryDir, account, positions, historyProvider);
    return;
  }

  const report = await runReplay({
    startDate: cli.from,
    endDate: cli.to,
    account,
    positions,
    historyProvider,
    memoryDir,
    reason: "replay",
    historyCount: cli.historyCount,
  });

  console.log(
    `✅ 重放完成：写入 ${report.totalWritten} 个时点快照（${report.skipped.length} 个节点未到点已跳过）。`,
  );
  for (const snapshot of report.snapshots) {
    console.log(
      `  ${snapshot.asOfDate} ${snapshot.alarmId}${snapshot.degraded ? " [降级]" : ""} → ${snapshot.snapshotId}`,
    );
  }
  console.log(`快照已落库：${memoryDir}/snapshots/<日期>/<snapshotId>.json`);

  if (cli.score) {
    // Score each as-of decision against the realized forward outcome (fenced look-ahead).
    const snapshots = report.snapshots.map((record) =>
      pointInTimeSnapshotSchema.parse(JSON.parse(readFileSync(record.filePath, "utf8"))),
    );
    const priorExperience = cli.experiencePath ? loadExperience(cli.experiencePath) : undefined;
    const decider = cli.model
      ? new ModelReplayDecider(
          config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain),
          { experience: priorExperience },
        )
      : deterministicReplayDecider;
    if (priorExperience && !cli.model) {
      console.log("（提示：--experience 仅在 --model 决策器下生效，已忽略）");
    }
    if (priorExperience && cli.model) {
      console.log(
        `已载入历史软经验（截至 ${priorExperience.coverageThroughDate ?? "—"}），仅对 asOf 晚于该日的决策生效（时间围栏）。`,
      );
    }
    const scoreResult = await scoreReplaySnapshots({
      snapshots,
      decider,
      forwardReader: new ForwardOutcomeReader(new FixtureHistoryProvider(barsBySymbol)),
      startDate: cli.from,
      endDate: cli.to,
      horizonTradingDays: cli.horizon,
      returnThreshold: cli.threshold,
      store: new DecisionMemoryStore({ memoryDir }),
    });
    console.log(`决策器：${cli.model ? "模型（结构化判断，只读、待人工复核）" : "确定性规则"}`);
    printScorecard(scoreResult.scorecard);
    console.log(`决策已落库：${memoryDir}/decisions/<日期>/<decisionId>.json`);

    // Distill the scored decisions into SOFT, advisory experience (never a hard rule).
    const experience = distillSoftExperience({
      scored: scoreResult.scored,
      startDate: cli.from,
      endDate: cli.to,
      horizonTradingDays: cli.horizon,
      returnThreshold: cli.threshold,
    });
    new ExperienceMemoryStore({ memoryDir }).writeReport(experience);
    printExperience(experience);
    console.log(`软经验已落库：${memoryDir}/experience/（仅供软提示，不改硬规则）`);

    printEquityCurve(computeEquityCurve(scoreResult.scored));

    // Soft experience -> hard-rule PROPOSALS (review-required; never auto-applied).
    const proposals = proposeRuleChangesFromExperience({ report: experience });
    if (proposals.length > 0) {
      const proposalStore = new RuleProposalMemoryStore({ memoryDir });
      for (const proposal of proposals) {
        proposalStore.writeProposal(proposal);
      }
      console.log("");
      console.log(`📋 硬规则变更提案（${proposals.length} 条，全部 待人工复核、绝不自动生效）`);
      for (const proposal of proposals) {
        console.log(`  [${proposal.observedVerdict}] ${proposal.recommendation}`);
      }
      console.log(`提案已落库：${memoryDir}/rule-proposals/（status=pending_human_review, autoApply=false）`);
    } else {
      console.log("（暂无满足样本阈值的硬规则提案）");
    }
  }
}

function printExperience(report: SoftExperienceReport): void {
  console.log("");
  console.log(`🧠 软经验沉淀（${report.lessons.length} 条规律，仅作软提示，绝不自动改硬规则）`);
  const conclusive = report.lessons.filter((lesson) => lesson.verdict !== "insufficient");
  for (const lesson of conclusive) {
    console.log(`  [${lesson.verdict}] ${lesson.advice}`);
  }
  const insufficient = report.lessons.length - conclusive.length;
  if (insufficient > 0) {
    console.log(`  （另有 ${insufficient} 条样本不足，暂不形成结论）`);
  }
}

async function runWalkForwardCli(
  cli: ReplayCli,
  config: ReturnType<typeof loadConfig>,
  memoryDir: string,
  account: Account,
  positions: Position[],
  historyProvider: FixtureHistoryProvider,
): Promise<void> {
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const makeDecider = cli.model
    ? (experience?: SoftExperienceReport) => new ModelReplayDecider(brainProvider, { experience })
    : () => deterministicReplayDecider;

  const { report, scored } = await runWalkForward({
    startDate: cli.from,
    endDate: cli.to,
    account,
    positions,
    historyProvider,
    memoryDir,
    windowDays: cli.windowDays,
    horizonTradingDays: cli.horizon,
    returnThreshold: cli.threshold,
    makeDecider,
    deciderKind: cli.model ? "model-replay-decider" : "deterministic-replay-decider",
  });

  printWalkForward(report);
  printEquityCurve(computeEquityCurve(scored));
  const reportPath = path.join(memoryDir, "walk-forward", `${cli.from}_${cli.to}.json`);
  new JsonStore<WalkForwardReport>({ filePath: reportPath, schema: walkForwardReportSchema }).write(report);
  console.log(`走步前向报告已落库：${reportPath}`);
}

function printEquityCurve(curve: EquityCurve): void {
  const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  console.log(
    `📈 策略净值（按倾向方向的代理指标，非真实盈亏）：净值 ${curve.endEquity.toFixed(4)}｜累计 ${pct(curve.totalReturn)}｜最大回撤 ${pct(curve.maxDrawdown)}（${curve.tradingDays} 个交易日）`,
  );
}

function printWalkForward(report: WalkForwardReport): void {
  const pct = (value: number | null): string => (value === null ? "—" : `${(value * 100).toFixed(2)}%`);
  console.log(
    `🔁 走步前向回测（窗口 ${report.windowDays} 天，前瞻 ${report.horizonTradingDays} 日，决策器：${report.decider}）：${report.startDate} → ${report.endDate}`,
  );
  for (const window of report.windows) {
    const experience = window.usedPriorExperience
      ? `历史经验已启用（截至 ${window.experienceCoverageThrough}，${window.experienceLessons} 条）`
      : "历史经验未启用（围栏未通过/尚无）";
    console.log(
      `  ${window.windowStart}~${window.windowEnd}｜决策 ${window.decisionsCount}｜可评估 ${window.scoredStances}｜命中率 ${pct(window.hitRate)}｜均前瞻 ${pct(window.avgForwardReturn)}｜${experience}`,
    );
  }
  console.log(
    `  —— 总体：决策 ${report.overall.decisionsCount}｜可评估 ${report.overall.scoredStances}｜命中率 ${pct(report.overall.hitRate)}｜均前瞻 ${pct(report.overall.avgForwardReturn)}`,
  );
}

function printScorecard(scorecard: ReplayScorecard): void {
  const pct = (value: number | null): string => (value === null ? "—" : `${(value * 100).toFixed(2)}%`);
  console.log("");
  console.log(
    `📊 回测打分（前瞻 ${scorecard.horizonTradingDays} 个交易日，阈值 ${pct(scorecard.returnThreshold)}，仅评估非未来数据决策）`,
  );
  console.log(
    `  决策 ${scorecard.decisionsCount} 个｜可评估持仓判断 ${scorecard.scoredStances} 个｜命中 ${scorecard.hitStances} 个`,
  );
  console.log(`  命中率 ${pct(scorecard.hitRate)}｜平均前瞻收益 ${pct(scorecard.avgForwardReturn)}`);
  for (const bias of ["increase", "hold", "reduce"] as const) {
    const row = scorecard.byBias[bias];
    console.log(
      `    ${bias.padEnd(8)} 评估 ${row.scored}｜命中率 ${pct(row.hitRate)}｜平均前瞻收益 ${pct(row.avgForwardReturn)}`,
    );
  }
}

function parseArgs(argv: string[]): ReplayCli {
  const result: Partial<ReplayCli> = {
    historyCount: 60,
    score: false,
    horizon: 5,
    threshold: 0,
    model: false,
    walkForward: false,
    windowDays: 7,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new ReplayCliError(`${arg} 需要一个值`);
      }
      i += 1;
      return value;
    };

    if (arg === "--from") {
      result.from = next();
    } else if (arg === "--to") {
      result.to = next();
    } else if (arg === "--memory-dir") {
      result.memoryDir = next();
    } else if (arg === "--history-count") {
      result.historyCount = Number(next());
    } else if (arg === "--score") {
      result.score = true;
    } else if (arg === "--horizon") {
      result.horizon = Number(next());
    } else if (arg === "--threshold") {
      result.threshold = Number(next());
    } else if (arg === "--model") {
      result.model = true;
    } else if (arg === "--experience") {
      result.experiencePath = next();
    } else if (arg === "--walk-forward") {
      result.walkForward = true;
    } else if (arg === "--window-days") {
      result.windowDays = Number(next());
    } else {
      throw new ReplayCliError(`未知参数：${arg}`);
    }
  }

  if (!result.from || !result.to) {
    throw new ReplayCliError("必须提供 --from 和 --to（YYYY-MM-DD）");
  }
  if (!Number.isInteger(result.historyCount) || result.historyCount! <= 0) {
    throw new ReplayCliError("--history-count 必须是正整数");
  }
  if (!Number.isInteger(result.horizon) || result.horizon! <= 0) {
    throw new ReplayCliError("--horizon 必须是正整数");
  }
  if (!Number.isFinite(result.threshold) || result.threshold! < 0) {
    throw new ReplayCliError("--threshold 必须是非负数");
  }
  if (!Number.isInteger(result.windowDays) || result.windowDays! <= 0) {
    throw new ReplayCliError("--window-days 必须是正整数");
  }

  return result as ReplayCli;
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

function loadExperience(experiencePath: string): SoftExperienceReport {
  try {
    return softExperienceReportSchema.parse(JSON.parse(readFileSync(experiencePath, "utf8")));
  } catch (error) {
    throw new ReplayCliError(
      `无法读取软经验文件 ${experiencePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

class ReplayCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayCliError";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof ReplayCliError || error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    console.error(error);
    process.exitCode = 1;
  });
}
