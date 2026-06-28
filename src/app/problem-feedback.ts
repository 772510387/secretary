import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { tradeRecordSchema, type TradeRecord } from "../domain/portfolio/index.js";
import { beijingDayOfWeek, toBeijingDate, type JsonValue } from "../domain/shared/index.js";
import { listPoolSnapshots, type PoolSnapshotRecord } from "./pool-snapshot-store.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_RANGE_DAYS = 31;
const FULL_POOL_TARGET = 100;

export interface ProblemFeedbackInput {
  memoryDir: string;
  query?: string;
  from?: string;
  to?: string;
  now?: Date | string;
}

export interface ProblemFeedbackFactPack {
  ok: boolean;
  generatedAt: string;
  query?: string;
  range: { from: string; to: string; truncated: boolean };
  summary: {
    expectedTradingDays: number;
    daysWithFullPool: number;
    daysWithAnyPool: number;
    daysMissingFullPool: string[];
    planDays: number;
    proposalDays: number;
    tradeDays: number;
    totalProposals: number;
    totalTrades: number;
    proposedSymbols: string[];
    tradedSymbols: string[];
  };
  days: ProblemFeedbackDay[];
  findings: string[];
  evidenceRefs: string[];
  answerGuidance: string[];
}

export interface ProblemFeedbackDay {
  date: string;
  weekday: number;
  expectedTradingDay: boolean;
  poolCoverage: "full" | "partial" | "missing";
  poolSnapshotCount: number;
  maxPoolSize: number;
  poolSnapshots: Array<{
    asOf: string;
    alarmType?: string;
    size: number;
    topBuckets: Array<{ bucket: string; count: number }>;
    evidencePath: string;
  }>;
  planFileCount: number;
  proposalCount: number;
  tradeCount: number;
  reportFileCount: number;
  proposedSymbols: string[];
  tradedSymbols: string[];
  evidenceRefs: string[];
  notes: string[];
}

interface ProposalSummary {
  symbol?: string;
  name?: string;
  side?: string;
}

export function buildProblemFeedbackFactPack(input: ProblemFeedbackInput): ProblemFeedbackFactPack {
  const generatedAt = normalizeNow(input.now);
  const range = resolveRange({ from: input.from, to: input.to, now: generatedAt });
  const dates = enumerateDates(range.from, range.to);
  const trades = readTrades(input.memoryDir);
  const days = dates.map((date) => buildDay(input.memoryDir, date, trades));
  const expectedTradingDays = days.filter((day) => day.expectedTradingDay);
  const daysWithFullPool = expectedTradingDays.filter((day) => day.poolCoverage === "full").length;
  const daysWithAnyPool = expectedTradingDays.filter((day) => day.poolCoverage !== "missing").length;
  const daysMissingFullPool = expectedTradingDays
    .filter((day) => day.poolCoverage !== "full")
    .map((day) => day.date);
  const proposalDays = expectedTradingDays.filter((day) => day.proposalCount > 0).length;
  const planDays = expectedTradingDays.filter((day) => day.planFileCount > 0).length;
  const tradeDays = expectedTradingDays.filter((day) => day.tradeCount > 0).length;
  const proposedSymbols = uniqueSorted(days.flatMap((day) => day.proposedSymbols));
  const tradedSymbols = uniqueSorted(days.flatMap((day) => day.tradedSymbols));
  const evidenceRefs = uniqueSorted(days.flatMap((day) => day.evidenceRefs)).slice(0, 80);

  return {
    ok: true,
    generatedAt,
    query: input.query?.trim() || undefined,
    range,
    summary: {
      expectedTradingDays: expectedTradingDays.length,
      daysWithFullPool,
      daysWithAnyPool,
      daysMissingFullPool,
      planDays,
      proposalDays,
      tradeDays,
      totalProposals: days.reduce((sum, day) => sum + day.proposalCount, 0),
      totalTrades: days.reduce((sum, day) => sum + day.tradeCount, 0),
      proposedSymbols,
      tradedSymbols,
    },
    days,
    findings: buildFindings(days),
    evidenceRefs,
    answerGuidance: [
      "回答用户问责时先给结论：哪些有证据、哪些没有证据，不要防御。",
      "如果 daysMissingFullPool 非空，明确承认这些交易日没有完整 100 池覆盖证据。",
      "区分“实际成交/模拟操作”和“候选提案/观察池覆盖”，不要把提案说成成交。",
      "引用 evidenceRefs 中的相对路径，缺失数据要说“未找到证据”，不要编造。",
      "最后给出补救动作：补池、固定每个交易日落 pool-snapshot、把复盘写入长期记忆或规则提案。",
    ],
  };
}

function buildDay(memoryDir: string, date: string, trades: readonly TradeRecord[]): ProblemFeedbackDay {
  const poolSnapshots = listPoolSnapshots(memoryDir, date);
  const maxPoolSize = poolSnapshots.reduce((max, snapshot) => Math.max(max, snapshot.size), 0);
  const poolCoverage = maxPoolSize >= FULL_POOL_TARGET ? "full" : maxPoolSize > 0 ? "partial" : "missing";
  const planFiles = listJsonFiles(path.join(memoryDir, "plans", date));
  const proposalFiles = listJsonFiles(path.join(memoryDir, "proposals", date));
  const reportFiles = listJsonFiles(path.join(memoryDir, "reports", date));
  const proposals = proposalFiles.map((file) => readProposal(file)).filter((item): item is ProposalSummary => item !== null);
  const dayTrades = trades.filter((trade) => trade.tradeDate === date);
  const evidenceRefs = [
    ...poolSnapshots.map(() => relativeMemoryPath("market", "pool-snapshots", `${date}.jsonl`)),
    ...planFiles.map((file) => toMemoryRelativePath(memoryDir, file)),
    ...proposalFiles.map((file) => toMemoryRelativePath(memoryDir, file)),
    ...reportFiles.map((file) => toMemoryRelativePath(memoryDir, file)),
    ...(dayTrades.length > 0 ? [relativeMemoryPath("portfolio", "trades.jsonl")] : []),
  ];
  const notes: string[] = [];

  if (beijingDayOfWeek(date) <= 5 && poolCoverage !== "full") {
    notes.push(poolCoverage === "missing" ? "未找到完整 100 池快照证据" : `观察池最大规模 ${maxPoolSize}，不足 ${FULL_POOL_TARGET}`);
  }
  if ((planFiles.length > 0 || proposalFiles.length > 0 || dayTrades.length > 0) && poolCoverage !== "full") {
    notes.push("存在计划/提案/成交痕迹，但缺少完整观察池覆盖证据");
  }

  return {
    date,
    weekday: beijingDayOfWeek(date),
    expectedTradingDay: beijingDayOfWeek(date) <= 5,
    poolCoverage,
    poolSnapshotCount: poolSnapshots.length,
    maxPoolSize,
    poolSnapshots: poolSnapshots.map((snapshot) => summarizePoolSnapshot(snapshot, date)),
    planFileCount: planFiles.length,
    proposalCount: proposalFiles.length,
    tradeCount: dayTrades.length,
    reportFileCount: reportFiles.length,
    proposedSymbols: uniqueSorted(proposals.map((proposal) => labelSymbol(proposal.symbol, proposal.name))),
    tradedSymbols: uniqueSorted(dayTrades.map((trade) => trade.symbol)),
    evidenceRefs: uniqueSorted(evidenceRefs),
    notes,
  };
}

function summarizePoolSnapshot(
  snapshot: PoolSnapshotRecord,
  date: string,
): ProblemFeedbackDay["poolSnapshots"][number] {
  return {
    asOf: snapshot.asOf,
    alarmType: snapshot.alarmType,
    size: snapshot.size,
    topBuckets: topBuckets(snapshot),
    evidencePath: relativeMemoryPath("market", "pool-snapshots", `${date}.jsonl`),
  };
}

function topBuckets(snapshot: PoolSnapshotRecord): Array<{ bucket: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of snapshot.entries) {
    const bucket = entry.bucket ?? "unknown";
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([bucket, count]) => ({ bucket, count }));
}

function buildFindings(days: readonly ProblemFeedbackDay[]): string[] {
  const expected = days.filter((day) => day.expectedTradingDay);
  const missingFull = expected.filter((day) => day.poolCoverage !== "full");
  const actionWithoutFullPool = expected.filter(
    (day) =>
      day.poolCoverage !== "full" &&
      (day.planFileCount > 0 || day.proposalCount > 0 || day.tradeCount > 0),
  );
  const findings: string[] = [];

  if (missingFull.length > 0) {
    findings.push(`观察池覆盖不足：${missingFull.map((day) => `${day.date}(${day.poolCoverage})`).join("、")}`);
  } else if (expected.length > 0) {
    findings.push("区间内每个预期交易日都有完整 100 池快照证据。");
  }

  if (actionWithoutFullPool.length > 0) {
    findings.push(
      `存在计划/提案/成交但无完整 100 池证据的日期：${actionWithoutFullPool.map((day) => day.date).join("、")}`,
    );
  }

  const operated = uniqueSorted(days.flatMap((day) => day.tradedSymbols));
  const proposed = uniqueSorted(days.flatMap((day) => day.proposedSymbols));
  if (operated.length > 0) {
    findings.push(`区间内成交覆盖 ${operated.length} 个标的：${operated.slice(0, 12).join("、")}`);
  }
  if (proposed.length > 0) {
    findings.push(`区间内候选/提案覆盖 ${proposed.length} 个标的：${proposed.slice(0, 12).join("、")}`);
  }
  if (findings.length === 0) {
    findings.push("区间内未找到观察池、计划、提案或成交证据。");
  }
  return findings;
}

function resolveRange(input: { from?: string; to?: string; now: string }): ProblemFeedbackFactPack["range"] {
  const today = toBeijingDate(input.now).date;
  const to = parseDateOr(input.to, today);
  const defaultFrom = addDays(to, -(DEFAULT_LOOKBACK_DAYS - 1));
  let from = parseDateOr(input.from, defaultFrom);
  let truncated = false;

  if (from > to) {
    from = to;
  }

  const days = enumerateDates(from, to);
  if (days.length > MAX_RANGE_DAYS) {
    from = addDays(to, -(MAX_RANGE_DAYS - 1));
    truncated = true;
  }

  return { from, to, truncated };
}

function parseDateOr(value: string | undefined, fallback: string): string {
  return value && DATE_RE.test(value) ? value : fallback;
}

function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  let current = from;
  while (current <= to && out.length <= MAX_RANGE_DAYS + 1) {
    out.push(current);
    current = addDays(current, 1);
  }
  return out;
}

function addDays(date: string, delta: number): string {
  const [year, month, day] = date.split("-").map((value) => Number.parseInt(value, 10));
  const utc = Date.UTC(year, month - 1, day + delta);
  return new Date(utc).toISOString().slice(0, 10);
}

function readTrades(memoryDir: string): TradeRecord[] {
  const file = path.join(memoryDir, "portfolio", "trades.jsonl");
  if (!existsSync(file)) {
    return [];
  }

  const out: TradeRecord[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(tradeRecordSchema.parse(JSON.parse(trimmed)));
    } catch {
      // Skip corrupt historical lines; feedback must remain available.
    }
  }
  return out;
}

function listJsonFiles(dir: string): string[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      return [];
    }
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function readProposal(file: string): ProposalSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, JsonValue>;
    return {
      symbol: typeof parsed.symbol === "string" ? parsed.symbol : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      side: typeof parsed.side === "string" ? parsed.side : undefined,
    };
  } catch {
    return null;
  }
}

function labelSymbol(symbol: string | undefined, name: string | undefined): string {
  if (!symbol) {
    return "";
  }
  return name ? `${name}(${symbol})` : symbol;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function toMemoryRelativePath(memoryDir: string, file: string): string {
  return path.relative(path.resolve(memoryDir), path.resolve(file)).replace(/\\/g, "/");
}

function relativeMemoryPath(...parts: string[]): string {
  return parts.join("/");
}

function normalizeNow(now: Date | string | undefined): string {
  if (now instanceof Date) {
    return Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  }
  if (typeof now === "string") {
    const parsed = new Date(now);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return new Date().toISOString();
}
