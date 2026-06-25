/**
 * 日内检查点 (intraday checkpoint): a deterministic snapshot of the market+holdings
 * state at one alarm node, appended to a per-day timeline. Feeding the PRIOR
 * checkpoints back to the brain gives node-to-node continuity — the model can reason
 * about "上次 10:00 → 本次 11:30" (情绪升温/退潮, 大盘拐头) instead of analyzing each
 * node from a blank slate. Pure of network/LLM; the timeline is the story spine.
 */
export interface CheckpointIndex {
  name: string;
  changePct: number;
}

export interface CheckpointHolding {
  symbol: string;
  name: string;
  price: number | null;
}

export interface IntradayCheckpoint {
  /** Beijing HH:mm of this observation. */
  time: string;
  /** ISO timestamp. */
  occurredAt: string;
  alarmType: string;
  indices: CheckpointIndex[];
  holdings: CheckpointHolding[];
  limitUpCount: number | null;
  limitDownCount: number | null;
  heatScore: number | null;
}

export interface BuildIntradayCheckpointInput {
  time: string;
  occurredAt: string;
  alarmType: string;
  indices?: ReadonlyArray<{ name: string; changePct: number }>;
  holdings?: ReadonlyArray<{ symbol: string; name: string; price?: number | null }>;
  themeHeat?: {
    limitUpCount: number | null;
    limitDownCount: number | null;
    heatScore: number;
    degraded?: boolean;
  };
}

export function buildIntradayCheckpoint(input: BuildIntradayCheckpointInput): IntradayCheckpoint {
  const heatPresent = input.themeHeat !== undefined && input.themeHeat.degraded !== true;
  return {
    time: input.time,
    occurredAt: input.occurredAt,
    alarmType: input.alarmType,
    indices: (input.indices ?? []).map((index) => ({
      name: index.name,
      changePct: index.changePct,
    })),
    holdings: (input.holdings ?? []).map((holding) => ({
      symbol: holding.symbol,
      name: holding.name,
      price: holding.price ?? null,
    })),
    limitUpCount: heatPresent ? input.themeHeat?.limitUpCount ?? null : null,
    limitDownCount: heatPresent ? input.themeHeat?.limitDownCount ?? null : null,
    heatScore: heatPresent ? input.themeHeat?.heatScore ?? null : null,
  };
}

/**
 * Renders today's checkpoint timeline (index moves + sentiment per node) as the
 * 盘面时间线 fed to the brain. The last checkpoint is the current node. Returns "" when
 * there is no history yet (first node of the day → nothing to compare against).
 */
export function renderIntradayTimeline(checkpoints: readonly IntradayCheckpoint[]): string {
  if (checkpoints.length <= 1) {
    return "";
  }
  const lines = [`盘面时间线（今日第 ${checkpoints.length} 次观察，按时间）：`];
  checkpoints.forEach((checkpoint, index) => {
    const isCurrent = index === checkpoints.length - 1;
    lines.push(`${checkpoint.time}${isCurrent ? "(本次)" : ""} ${renderCheckpointLine(checkpoint)}`);
  });
  lines.push("请对比上次→本次的大盘与情绪变化（升温还是退潮、是否拐头），并据此研判。");
  return lines.join("\n");
}

function renderCheckpointLine(checkpoint: IntradayCheckpoint): string {
  const parts: string[] = [];
  const indexPart = checkpoint.indices
    .slice(0, 3)
    .map((index) => `${shortIndexName(index.name)}${formatSignedPct(index.changePct)}`)
    .join("/");
  if (indexPart) {
    parts.push(indexPart);
  }
  if (checkpoint.limitUpCount !== null) {
    parts.push(`涨停${checkpoint.limitUpCount}家`);
  }
  if (checkpoint.limitDownCount !== null) {
    parts.push(`跌停${checkpoint.limitDownCount}家`);
  }
  if (checkpoint.heatScore !== null) {
    parts.push(`热度${checkpoint.heatScore}`);
  }
  return parts.join(" ") || "（无可比对数据）";
}

function shortIndexName(name: string): string {
  return name.replace(/指数$/, "").replace(/^上证综合?/, "上证").slice(0, 6);
}

function formatSignedPct(changePct: number): string {
  const sign = changePct > 0 ? "+" : "";
  return `${sign}${changePct.toFixed(2)}%`;
}
