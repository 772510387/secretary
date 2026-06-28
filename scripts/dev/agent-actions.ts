import type { AppConfig } from "../../src/config/index.js";
import {
  buildInitialPaperAccountSeed,
  createTradingDayReviewFromMemory,
  createResearchRunner,
  formatPaperOpsCommand,
  type AgentAction,
} from "../../src/app/index.js";
import { brainInputSchema, type BrainProvider } from "../../src/domain/brain/index.js";
import type { NotificationEvent } from "../../src/domain/notification/index.js";
import type { CerebellumAlarmType } from "../../src/domain/cerebellum/index.js";
import type { JsonValue } from "../../src/domain/shared/index.js";
import { DailyBudget } from "../../src/runtime/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import { initializePaperAccountMemory } from "../../src/infrastructure/storage/index.js";
import {
  createAlarmRunNode,
  runDueNodesForDate,
  runReplayDay,
  type ReplayDayRunResult,
  type CerebellumSchedulerDeps,
} from "./cerebellum-daemon.js";

export interface ExecuteAgentActionOptions {
  config: AppConfig;
  memoryDir: string;
}

const PAPER_SIM_NODE_TYPES: ReadonlySet<CerebellumAlarmType> = new Set([
  "pre_market_plan",
  "call_auction_watch",
  "morning_review",
  "midday_review",
  "afternoon_risk_scan",
  "late_session_plan",
  "closing_review",
]);

export async function executeAgentAction(
  action: AgentAction,
  options: ExecuteAgentActionOptions,
): Promise<string> {
  switch (action.type) {
    case "reset_paper":
    case "seed_paper":
      return executeSeedOrReset(action, options);

    case "paper_ops":
      return executePaperOps(action, options);
  }
}

function executeSeedOrReset(
  action: Extract<AgentAction, { type: "reset_paper" | "seed_paper" }>,
  options: ExecuteAgentActionOptions,
): string {
  const seed = buildInitialPaperAccountSeed({
    initialCash: action.type === "seed_paper" ? action.initialCash ?? options.config.trading.initialCash : options.config.trading.initialCash,
  });
  const result = initializePaperAccountMemory({
    memoryDir: options.memoryDir,
    seed,
    reset: true,
    dryRun: false,
  });

  return `账户 ${seed.account.accountId}，初始资金 ${seed.account.initialCash} 元，已写入 ${result.writtenFiles.length} 个文件。`;
}

async function executePaperOps(
  action: Extract<AgentAction, { type: "paper_ops" }>,
  options: ExecuteAgentActionOptions,
): Promise<string> {
  const notifications: string[] = [];
  const deps = buildPaperOpsDeps(options, notifications);
  const completed: string[] = [];
  const replayResults: ReplayDayRunResult[] = [];

  // 单个闹钟场景重演: when the command names one node, scope replay/simulate to just it.
  const nodeScope = action.node ? `（仅 ${action.node} 节点）` : "";

  if (action.replayDate) {
    // INFRA-01: an operator "走一遍某日" should produce real funnel output even if the
    // stored pool is empty — rebuild it from the current universe (non-as-of, logged).
    replayResults.push(
      await runReplayDay(deps, action.replayDate, {
        refreshWatchlistWhenEmpty: true,
        onlyNode: action.node,
      }),
    );
    completed.push(`已忠实重演 ${action.replayDate}${nodeScope}`);
  }

  if (action.simulateDate) {
    await runDueNodesForDate(deps, action.simulateDate, {
      includeAlarmTypes: action.node ? new Set([action.node]) : PAPER_SIM_NODE_TYPES,
    });
    completed.push(`已补跑 ${action.simulateDate} 今日模拟节点${nodeScope}`);
  }

  if (action.archiveDate) {
    await createAlarmRunNode(deps)("post_close_review", `${action.archiveDate}T07:30:00.000Z`);
    completed.push(`已归档 ${action.archiveDate} 盘后账户快照`);
  }

  const opsReport = await buildPaperOpsMarkdownReport({
    action,
    completed,
    notifications,
    replayResults,
    brainProvider: deps.brainProvider,
  });
  const reviewDate = action.archiveDate ?? action.simulateDate ?? action.replayDate;
  const dayReview = reviewDate
    ? buildTradingDayReviewAppendix(options.memoryDir, reviewDate, options.config.trading.t1Enabled)
    : undefined;

  return dayReview ? `${opsReport}\n\n---\n\n${dayReview}` : opsReport;
}

function buildPaperOpsDeps(
  options: ExecuteAgentActionOptions,
  notifications: string[],
): CerebellumSchedulerDeps {
  const config = options.config;
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);

  return {
    config,
    memoryDir: options.memoryDir,
    brainProvider,
    researchRunner:
      config.research.provider === "trading_agents_cn" ? createResearchRunner(config) : undefined,
    budget: new DailyBudget({
      brain: config.budget.brainDailyLimit,
      research: config.budget.researchDailyLimit,
      search: config.budget.searchDailyLimit,
    }),
    push: async (notification: NotificationEvent) => {
      notifications.push(notification.summary);
    },
    autoPaper: true,
  };
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function buildTradingDayReviewAppendix(
  memoryDir: string,
  tradingDate: string,
  t1Enabled: boolean,
): string | undefined {
  try {
    const review = createTradingDayReviewFromMemory({
      memoryDir,
      tradingDate,
      t1Enabled,
      write: true,
    });
    const location = review.write ? `\n\n报告已落盘：${review.write.filePath}` : "";
    return `${review.markdown}${location}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "# 完整交易日复盘",
      "",
      `无法生成 ${tradingDate} 的接地复盘：${clip(message, 220)}`,
      "已执行的模拟运维报告仍以上方内容为准。",
    ].join("\n");
  }
}

export interface PaperOpsMarkdownReportInput {
  action: Extract<AgentAction, { type: "paper_ops" }>;
  completed: string[];
  notifications: string[];
  replayResults: ReplayDayRunResult[];
  brainProvider: BrainProvider;
  now?: () => Date;
}

export async function buildPaperOpsMarkdownReport(
  input: PaperOpsMarkdownReportInput,
): Promise<string> {
  const fallback = buildPaperOpsFallbackMarkdown(input);

  if (input.brainProvider.providerName === "mock") {
    return fallback;
  }

  try {
    const now = input.now ?? (() => new Date());
    const generatedAt = now();
    const output = await input.brainProvider.generate(
      brainInputSchema.parse({
        requestId: `paper_ops_report_${generatedAt.getTime()}`,
        taskType: "research_summary",
        prompt: [
          "你是 Secretary 的 A 股模拟盘运维复盘助手。",
          "请只基于 context 中的已发生事实整理最终报告，不得编造行情、持仓、成交或原因。",
          "输出必须是 Markdown，写入 BrainOutput.summary 字段；structured 可返回 {\"format\":\"markdown\"}。",
          "报告必须包含：# 模拟运维结果、## 执行范围、## 操作回放、## 成交与未成交、## 风险观察。",
          "每条交易相关内容必须写清节点、方向、代码、名称、股数、价格、执行状态、跳过/失败原因。",
          "如果没有成交，要明确写无成交及原因；如果信息缺失，要写未提供。",
          "禁止下单、禁止要求用户再次确认、禁止修改账户、禁止覆盖规则文件。",
        ].join("\n"),
        context: buildPaperOpsReportContext(input),
        constraints: {
          locale: "zh-CN",
          timezone: "Asia/Shanghai",
          outputFormat: "markdown",
          maxSummaryLength: 12000,
          toolPermissions: [],
        },
        createdAt: generatedAt.toISOString(),
      }),
    );
    const markdown = normalizeMarkdownReport(output.summary);
    return looksLikeMarkdownReport(markdown) ? markdown : fallback;
  } catch {
    return fallback;
  }
}

function buildPaperOpsFallbackMarkdown(input: {
  action: Extract<AgentAction, { type: "paper_ops" }>;
  completed: string[];
  notifications: string[];
  replayResults: ReplayDayRunResult[];
}): string {
  const replayLines = input.replayResults.flatMap((result) => summarizeReplayResult(result));
  const notificationLines = summarizeOperationNotifications(input.notifications);
  const operationLines = dedupeLines([...replayLines, ...notificationLines]);
  const completedLines =
    input.completed.length > 0
      ? input.completed
      : [`未找到可执行步骤（${formatPaperOpsCommand(input.action)}）`];
  const latestNotification =
    input.notifications.length > 0 ? clip(input.notifications[input.notifications.length - 1]!, 360) : "未提供";

  return [
    "# 模拟运维结果",
    "",
    "## 执行范围",
    ...completedLines.map((item) => `- ${item}`),
    "",
    "## 节点统计",
    `- 节点报告：${input.notifications.length} 条`,
    "- 完整节点内容：已按节点逐条推送",
    "",
    "## 操作回放",
    ...(operationLines.length > 0
      ? operationLines.slice(0, 24)
      : ["- 本次未形成可执行建仓/减仓节点；后端无模拟成交。"]),
    "",
    "## 成交与未成交",
    ...summarizeExecutionOutcomes(input.replayResults),
    "",
    "## 风险观察",
    `- 最近节点摘要：${latestNotification}`,
  ].join("\n");
}

function buildPaperOpsReportContext(input: {
  action: Extract<AgentAction, { type: "paper_ops" }>;
  completed: string[];
  notifications: string[];
  replayResults: ReplayDayRunResult[];
}): JsonValue {
  return {
    command: formatPaperOpsCommand(input.action),
    completed: input.completed,
    notificationCount: input.notifications.length,
    operationReplay: input.replayResults.flatMap((result) => summarizeReplayResult(result)),
    operationNotifications: summarizeOperationNotifications(input.notifications),
    recentNotifications: input.notifications.slice(-8).map((summary) => clip(summary, 700)),
    replayResults: input.replayResults.map((result) => ({
      date: result.date,
      nodeCount: result.nodeCount,
      poolSource: result.poolSource ?? null,
      poolFaithful: result.poolFaithful ?? false,
      nodes: result.nodes.map((node) => ({
        alarmType: node.alarmType,
        beijingTime: node.beijingTime,
        report: clip(node.report, 700),
        error: node.error ?? null,
        funnel:
          node.funnel === undefined
            ? null
            : {
                planId: node.funnel.planId ?? null,
                shortlistCount: node.funnel.shortlistCount,
                autoPaper: node.funnel.autoPaper,
                degraded: node.funnel.degraded,
                skippedReason: node.funnel.skippedReason ?? null,
                // 潜力股名单 + 逐只选股理由 — so the report explains WHY each was shortlisted, not just a count.
                shortlist: node.funnel.shortlist10.map((entry) => ({
                  symbol: entry.symbol,
                  name: entry.name,
                  rank: entry.rank ?? null,
                  rationale: clip(entry.rationale, 160),
                })),
                proposals: node.funnel.proposals.map((proposal) => ({
                  side: proposal.side,
                  symbol: proposal.symbol,
                  name: proposal.name ?? null,
                  quantity: proposal.quantity ?? null,
                  limitPrice: proposal.limitPrice ?? null,
                  rationale: proposal.rationale,
                })),
                executions: node.funnel.executions.map((execution) => ({
                  side: execution.side,
                  symbol: execution.symbol,
                  name: execution.name ?? null,
                  status: execution.status,
                  quantity: execution.quantity ?? null,
                  limitPrice: execution.limitPrice ?? null,
                  reason: execution.reason ?? null,
                  idempotent: execution.idempotent ?? false,
                })),
              },
      })),
    })),
  };
}

function summarizeExecutionOutcomes(replayResults: ReplayDayRunResult[]): string[] {
  const outcomes = replayResults.flatMap((result) =>
    result.nodes.flatMap((node) =>
      node.funnel?.executions.map((execution) => {
        const name = execution.name ? ` ${execution.name}` : "";
        const sized =
          execution.quantity !== undefined && execution.limitPrice !== undefined
            ? ` ${execution.quantity}股@${execution.limitPrice}`
            : "";
        const reason = execution.reason ? `；原因：${execution.reason}` : "";
        return `- ${node.beijingTime} ${node.alarmType}：${execution.side} ${execution.symbol}${name}，${execution.status}${sized}${reason}`;
      }) ?? [],
    ),
  );

  return outcomes.length > 0 ? outcomes : ["- 无后端模拟成交记录。"];
}

function normalizeMarkdownReport(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:markdown)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (fenced?.[1] ?? trimmed).trim();
}

function looksLikeMarkdownReport(text: string): boolean {
  return text.startsWith("# ") || text.includes("\n## ");
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    deduped.push(line);
  }
  return deduped;
}

function summarizeReplayResult(result: ReplayDayRunResult): string[] {
  const lines: string[] = [];
  if (result.poolSource) {
    lines.push(
      `- ${result.date} 选股池来源：${result.poolSource}${result.poolFaithful ? "" : "（⚠️非该日历史池，重演不同未记录历史日会拿到同一套当日池，不能据此比较选股差异）"}`,
    );
  }
  for (const node of result.nodes) {
    if (node.funnel === undefined) {
      continue;
    }

    const label = `${node.beijingTime} ${node.alarmType}`;
    if (node.funnel.skippedReason) {
      lines.push(`- ${label}：交易漏斗跳过（${node.funnel.skippedReason}）。`);
      continue;
    }

    // 潜力股名单 + 逐只入选理由 — answer "为何选这些股", not just a count.
    if (node.funnel.shortlist10.length > 0) {
      const shortlistText = node.funnel.shortlist10
        .map((entry) => `${entry.name}(${entry.symbol})｜${clip(entry.rationale, 60)}`)
        .join("；");
      lines.push(`- ${label} 潜力股${node.funnel.shortlist10.length}支(为何入选)：${shortlistText}`);
    }

    if (node.funnel.proposals.length === 0) {
      lines.push(`- ${label}：模型未选择可执行建仓/减仓操作；后端无模拟成交。`);
      continue;
    }

    const proposalText = node.funnel.proposals
      .map((proposal) => {
        const sized =
          proposal.quantity !== undefined && proposal.limitPrice !== undefined
            ? ` ${proposal.quantity}股@${proposal.limitPrice}`
            : "";
        return `${proposal.side} ${proposal.symbol}${proposal.name ? ` ${proposal.name}` : ""}${sized}（${clip(proposal.rationale, 60)}）`;
      })
      .join("；");
    const executionText =
      node.funnel.executions.length > 0
        ? node.funnel.executions.map((execution) => {
            const fill =
              execution.quantity !== undefined && execution.limitPrice !== undefined
                ? ` ${execution.quantity}股@${execution.limitPrice}`
                : "";
            const reason = execution.reason ? `，${execution.reason}` : "";
            return `${execution.side} ${execution.symbol}：${execution.status}${fill}${reason}`;
          }).join("；")
        : "未执行自动 paper 成交";
    lines.push(`- ${label}：模型选择 ${proposalText}；后端执行 ${executionText}。`);
  }
  return lines;
}

function summarizeOperationNotifications(notifications: string[]): string[] {
  return notifications
    .filter((summary) => summary.includes("【选股漏斗") || summary.includes("【模拟盘后端处理"))
    .map((summary) => `- ${clip(summary, 220)}`);
}
