import { beijingDayOfWeek } from "../domain/shared/index.js";
import type { CerebellumAlarmType } from "../domain/cerebellum/index.js";

export interface PaperOpsCommand {
  replayDate?: string;
  simulateDate?: string;
  archiveDate?: string;
  /** When set, scope the replay/simulate to this SINGLE alarm node instead of the whole day. */
  node?: CerebellumAlarmType;
  /**
   * When set, scope the replay/simulate to this GROUP of alarm nodes (e.g. all pre-open
   * nodes before 09:30) instead of the whole day or a single node. Takes precedence over
   * `node` is not assumed — they are mutually exclusive in practice (a group request never
   * also names one node).
   */
  nodes?: CerebellumAlarmType[];
}

/** Alarm nodes scheduled before 09:30 Beijing — the "开盘前 / 9:30 前" group. */
export const PRE_OPEN_NODES: readonly CerebellumAlarmType[] = [
  "data_warmup", // 08:00
  "overnight_digest", // 08:15
  "pre_market_plan", // 08:30
  "call_auction_watch", // 09:15
  "pre_open_confirmation", // 09:25
];

// "开盘前 / 开盘之前 / 9:30前 / 九点半前 / 早盘前" — unambiguous pre-open-window markers.
// Bare "盘前" is intentionally excluded so "做个盘前计划" stays a single read-only SOP.
const PRE_OPEN_WINDOW_RE = /(开盘前|开盘之前|9[:：]?30\s*前|9[:：]?30\s*之前|九点半前|九点三十前|早盘前)/u;
// A collective / operation marker that turns the window into a "run the whole group" ask.
const GROUP_OR_OP_RE = /(所有|全部|都|各个?|逐个|整套|流程|节点|操作|模拟|复盘|跑|执行|重演|重跑|补跑|走一遍|过一遍)/u;

/**
 * Detects "开盘前 / 9:30前的所有操作/节点" → the pre-open node group. Deterministic; the
 * model never resolves this. Returns undefined when the message is not a pre-open-group ask.
 */
export function resolvePreOpenNodeGroup(message: string): CerebellumAlarmType[] | undefined {
  const text = message.trim();
  if (!text) {
    return undefined;
  }
  if (!PRE_OPEN_WINDOW_RE.test(text) || !GROUP_OR_OP_RE.test(text)) {
    return undefined;
  }
  return [...PRE_OPEN_NODES];
}

/**
 * Phrase → single alarm node, for "只重演早盘/模拟九点一刻那个闹钟". Aliases are matched
 * longest-first so "八点半"(pre_market_plan) beats "八点"(data_warmup). Deterministic; the
 * model never resolves these. Returns undefined when no node phrase is present.
 */
const NODE_ALIASES: ReadonlyArray<readonly [CerebellumAlarmType, readonly string[]]> = [
  ["data_warmup", ["08:00", "8:00", "八点整", "八点钟", "八点", "8点", "体检", "冒烟", "自检"]],
  ["overnight_digest", ["08:15", "8:15", "八点一刻", "八点十五", "隔夜", "外盘", "隔夜消息"]],
  ["pre_market_plan", ["08:30", "8:30", "八点半", "晨报", "盘前计划", "盘前规划", "早盘计划", "盘前"]],
  ["call_auction_watch", ["09:15", "9:15", "九点一刻", "九点十五", "集合竞价", "竞价"]],
  ["pre_open_confirmation", ["09:25", "9:25", "九点二十五", "开盘确认", "开盘"]],
  ["morning_review", ["10:30", "10点半", "十点半", "早盘回顾", "早盘总结", "早盘一小时"]],
  ["midday_review", ["11:30", "11点半", "十一点半", "上午收盘", "午盘", "午间", "上午总结"]],
  ["afternoon_risk_scan", ["13:30", "13点半", "一点半", "下午一点半", "午后", "跳水"]],
  ["late_session_plan", ["14:30", "14点半", "两点半", "尾盘", "炸板", "抢筹"]],
  ["closing_snapshot", ["15:00", "15点", "三点", "收盘"]],
  ["post_close_review", ["15:30", "15点半", "三点半", "盘后", "龙虎榜"]],
  ["deep_review", ["20:30", "八点半晚", "深度复盘", "盘后复盘"]],
  ["daily_reflection", ["21:00", "21点", "晚间内省", "内省", "晚间复盘"]],
];

export function resolveReplayNode(message: string): CerebellumAlarmType | undefined {
  const text = message.trim();
  if (!text) {
    return undefined;
  }
  const candidates: Array<{ alias: string; node: CerebellumAlarmType }> = [];
  for (const [node, aliases] of NODE_ALIASES) {
    for (const alias of aliases) {
      candidates.push({ alias, node });
    }
  }
  // Longest alias first so the most specific time/name wins (八点半 > 八点).
  candidates.sort((left, right) => right.alias.length - left.alias.length);
  for (const candidate of candidates) {
    if (text.includes(candidate.alias)) {
      return candidate.node;
    }
  }
  return undefined;
}

const DATE_PATTERN = /\b(20\d{2}-\d{2}-\d{2})\b/g;
const EXPLICIT_DATE_FRAGMENT = String.raw`20\d{2}-\d{2}-\d{2}`;
// Chinese relative-date expressions for a PAST (replay) target. Deterministic — the
// model never resolves these. "今天/今日/当天" is intentionally excluded (that is the
// simulate-today target, handled separately).
const WEEKDAY_FRAGMENT = String.raw`(?:上上|上|本|这|当|下下|下)?(?:个)?(?:周|星期|礼拜)[一二三四五六日天]`;
const RELATIVE_PAST_FRAGMENT = String.raw`(?:大前天|前天|昨天|昨日|${WEEKDAY_FRAGMENT}|[0-9]+(?:个)?(?:交易日|天|日)前|[一二三四五六七八九十](?:个)?(?:交易日|天|日)前)`;
const DATE_TARGET_FRAGMENT = String.raw`(?:${RELATIVE_PAST_FRAGMENT}|${EXPLICIT_DATE_FRAGMENT})`;
// Explicit "replay" verbs (re-run a past day's operations).
const REPLAY_VERB_FRAGMENT = String.raw`重新|补跑|重放|回放|复现|重演|重走|重跑`;
// "Walk/run through (a day's) process once" idioms — colloquial replay requests like
// "把本周一的流程走一遍 / 跑一遍周一 / 过一遍那天的节点". These are unambiguous replay asks
// even without an explicit 重演/补跑 verb, so they must reach paper_ops, not a read-only SOP.
const RUN_THROUGH_FRAGMENT = String.raw`走一遍|走一走|走一趟|走完|跑一遍|跑一趟|跑一跑|跑完|过一遍|过一趟|演练一遍|完整走一遍|重新走一遍|重新跑一遍`;
const ZH_WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const ZH_NUMBER: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Conservative detector for paper-only operator commands:
 * - "replay/simulate yesterday's operation"
 * - "replay yesterday, refresh/archive DB state, then simulate today's paper flow"
 *
 * This intentionally runs before the model router. It is state-changing and
 * should never be downgraded to a read-only review SOP by fuzzy routing.
 */
export function detectPaperOpsCommand(message: string, now?: string | Date): PaperOpsCommand | undefined {
  const text = message.trim();

  if (!text) {
    return undefined;
  }

  // Pre-open-group ("开盘前 / 9:30前的所有操作") routes deterministically to the 5 pre-open
  // nodes — a TODAY simulation by default, or a replay when a past date is named. This runs
  // before the generic detectors because "今天开盘前的所有操作" carries no date-target and
  // would otherwise fall through to the model, which mis-staged it as a whole-day replay.
  const preOpenGroup = resolvePreOpenNodeGroup(text);
  if (preOpenGroup) {
    const today = beijingDate(now);
    const pastDate = extractExplicitDates(text)[0] ?? resolveRelativePastDate(text, today);
    return pastDate
      ? { replayDate: pastDate, nodes: preOpenGroup }
      : { simulateDate: today, nodes: preOpenGroup };
  }

  const replayRequested = new RegExp(
    [
      String.raw`(${REPLAY_VERB_FRAGMENT}).*(${DATE_TARGET_FRAGMENT}|操作|流程)`,
      String.raw`(${DATE_TARGET_FRAGMENT}).*(操作|流程|模拟|${REPLAY_VERB_FRAGMENT}|${RUN_THROUGH_FRAGMENT})`,
      String.raw`(模拟|${REPLAY_VERB_FRAGMENT}|${RUN_THROUGH_FRAGMENT}).*(${DATE_TARGET_FRAGMENT}).*(操作|流程)?`,
      String.raw`(${DATE_TARGET_FRAGMENT}).*(流程|节点).*(${RUN_THROUGH_FRAGMENT}|${REPLAY_VERB_FRAGMENT})`,
    ].join("|"),
    "u",
  ).test(text);
  const archiveRequested = /(更新|刷新|归档|落库|落盘|罗盘|写库|入库|沉淀).*(数据库|DB|账本|快照|数据库信息|数据)|((数据库|DB|账本|快照).*(更新|刷新|归档|落库|落盘|罗盘|写库|入库|沉淀))/iu.test(text);
  const simulateRequested = /(模拟|补跑|执行|跑).*(今天|今日|当天).*(操作|节点|流程|模拟)|((今天|今日).*(模拟|补跑|执行|操作))/u.test(text);
  const standaloneReplayRequested =
    replayRequested &&
    new RegExp(
      [
        String.raw`(模拟|${REPLAY_VERB_FRAGMENT}|${RUN_THROUGH_FRAGMENT}).*(${DATE_TARGET_FRAGMENT})`,
        String.raw`(${DATE_TARGET_FRAGMENT}).*(模拟|${REPLAY_VERB_FRAGMENT}|${RUN_THROUGH_FRAGMENT})`,
        String.raw`(${DATE_TARGET_FRAGMENT}).*(流程|节点).*(${RUN_THROUGH_FRAGMENT}|${REPLAY_VERB_FRAGMENT})`,
      ].join("|"),
      "u",
    ).test(text);

  const requestedCount = [replayRequested, archiveRequested, simulateRequested].filter(Boolean).length;

  // Single-node scope: only meaningful when a replay/simulate is the op (not pure archive).
  const node = replayRequested || simulateRequested ? resolveReplayNode(text) : undefined;
  // A lone simulate normally needs a second op, BUT "模拟今天<某节点>" names one specific node
  // → high-intent, safe to honor on its own (单个闹钟场景模拟).
  const standaloneSimulateWithNode = simulateRequested && node !== undefined;

  if (requestedCount < 2 && !standaloneReplayRequested && !standaloneSimulateWithNode) {
    return undefined;
  }

  const today = beijingDate(now);
  const explicitDates = extractExplicitDates(text);
  const replayDate = replayRequested
    ? explicitDates[0] ?? resolveRelativePastDate(text, today) ?? addDays(today, -1)
    : undefined;

  return {
    replayDate,
    archiveDate: archiveRequested ? today : undefined,
    simulateDate: simulateRequested ? today : undefined,
    node,
  };
}

/**
 * Whether the user explicitly asked to run a paper op NOW, skipping the confirm
 * round-trip — "直接执行/直接落库/不用确认/马上跑一遍…就行". The bridge consults this
 * only for paper_ops (paper-only, owner-gated), honouring "直接…就行" while keeping the
 * default safe for unflagged requests. Pure and deterministic.
 */
export function wantsImmediatePaperExecution(message: string): boolean {
  const text = message.trim();
  if (!text) {
    return false;
  }
  const skipConfirm = /(不用|无需|别|不要|甭)(?:再)?(确认|问|管)/u.test(text);
  const immediacy = /(直接|立刻|立即|马上|径直|赶紧|尽快)/u.test(text);
  const actiony = /(执行|落库|落盘|罗盘|写库|入库|下单|成交|建仓|操作|跑一遍|走一遍|就行|就好|即可)/u.test(text);
  return skipConfirm || (immediacy && actiony);
}

const NODE_LABEL: Partial<Record<CerebellumAlarmType, string>> = {
  data_warmup: "08:00 体检",
  overnight_digest: "08:15 隔夜消息",
  pre_market_plan: "08:30 盘前计划",
  call_auction_watch: "09:15 集合竞价",
  pre_open_confirmation: "09:25 开盘确认",
  morning_review: "10:30 早盘回顾",
  midday_review: "11:30 上午收盘",
  afternoon_risk_scan: "13:30 午后排查",
  late_session_plan: "14:30 尾盘",
  closing_snapshot: "15:00 收盘",
  post_close_review: "15:30 盘后",
  deep_review: "20:30 深度复盘",
  daily_reflection: "21:00 内省",
};

export function formatPaperOpsCommand(command: PaperOpsCommand): string {
  const parts: string[] = [];
  const nodeScope = command.node
    ? `（仅 ${NODE_LABEL[command.node] ?? command.node} 节点）`
    : command.nodes && command.nodes.length > 0
      ? `（仅开盘前 ${command.nodes.length} 个节点：${command.nodes
          .map((node) => NODE_LABEL[node] ?? node)
          .join("、")}）`
      : "";

  if (command.replayDate) {
    parts.push(`重演 ${command.replayDate}${nodeScope}`);
  }
  if (command.simulateDate) {
    parts.push(`补跑 ${command.simulateDate} 今日模拟节点${nodeScope}`);
  }
  if (command.archiveDate) {
    parts.push(`归档 ${command.archiveDate} 盘后账户快照`);
  }

  return parts.length > 0 ? parts.join("；") : "模拟运维";
}

export function beijingDate(now: string | Date | undefined = new Date()): string {
  const date = now instanceof Date ? now : new Date(now);

  if (Number.isNaN(date.getTime())) {
    return beijingDate(new Date());
  }

  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function extractExplicitDates(text: string): string[] {
  const matches = [...text.matchAll(DATE_PATTERN)].map((match) => match[1]!).filter(isValidDate);
  return [...new Set(matches)];
}

/**
 * Deterministically resolves a Chinese relative-date expression for a PAST (replay)
 * target against a Beijing `today` (YYYY-MM-DD). Returns undefined when no past
 * expression is found, or when the expression points to a future day (e.g. 下周一) —
 * a future date is never a valid replay target. The model is never involved.
 */
export function resolveRelativePastDate(text: string, today: string): string | undefined {
  const weekday = new RegExp(
    String.raw`(上上|上|本|这|当|下下|下)?(?:个)?(?:周|星期|礼拜)([一二三四五六日天])`,
    "u",
  ).exec(text);
  if (weekday) {
    const weekOffset =
      weekday[1] === "上"
        ? -1
        : weekday[1] === "上上"
          ? -2
          : weekday[1] === "下"
            ? 1
            : weekday[1] === "下下"
              ? 2
              : 0;
    if (weekOffset > 0) {
      return undefined; // 下周X — future, not a replay target.
    }
    const targetDow = ZH_WEEKDAY[weekday[2]!]!;
    const delta = targetDow - beijingDayOfWeek(today) + weekOffset * 7;
    const resolved = addDays(today, delta);
    // A weekday still ahead this week (e.g. 本周五 asked on a Wednesday) hasn't
    // happened yet — not a valid past replay target.
    return resolved > today ? undefined : resolved;
  }

  if (/大前天/u.test(text)) {
    return addDays(today, -3);
  }
  if (/前天/u.test(text)) {
    return addDays(today, -2);
  }
  if (/昨天|昨日/u.test(text)) {
    return addDays(today, -1);
  }

  const digitsAgo = /([0-9]+)\s*(?:个)?\s*(?:交易日|天|日)前/u.exec(text);
  if (digitsAgo) {
    const days = Number(digitsAgo[1]);
    if (Number.isFinite(days) && days > 0) {
      return addDays(today, -days);
    }
  }

  const zhAgo = /([一二三四五六七八九十])\s*(?:个)?\s*(?:交易日|天|日)前/u.exec(text);
  if (zhAgo) {
    return addDays(today, -ZH_NUMBER[zhAgo[1]!]!);
  }

  return undefined;
}

function addDays(date: string, offset: number): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  const next = new Date(ms + offset * DAY_MS);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

function isValidDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && value === `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
