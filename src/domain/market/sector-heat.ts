import { classifyLimitState } from "./theme-heat.js";
import { isLikelySTName, type UniverseStock } from "./screener.js";

/**
 * 板块涨幅榜 (sector heat): aggregates the universe by 所属行业 (f100 sector) into a
 * 领涨/领跌 ranking — the "主线切换/板块强弱" signal the audit called a 载重墙. Deterministic
 * mean over members; degrades to empty when the source carries no sector (honest, not faked).
 */
export interface SectorHeat {
  sector: string;
  memberCount: number;
  /** Equal-weight mean 涨跌幅 (%) across members with changePct. */
  avgChangePct: number;
  /** 成交额 sum (yuan). */
  totalAmount: number;
  limitUpCount: number;
}

export interface SectorHeatSummary {
  topGainers: SectorHeat[];
  topLosers: SectorHeat[];
  /** How many sectors cleared the member floor. */
  sectorCount: number;
}

export interface ComputeSectorHeatOptions {
  /** Minimum members for a sector to rank (avoids 1-stock "sectors"). */
  minMembers?: number;
  topN?: number;
  /** Restrict to tradable non-ST names (default true). */
  excludeST?: boolean;
}

export function computeSectorHeat(
  universe: readonly UniverseStock[],
  options: ComputeSectorHeatOptions = {},
): SectorHeatSummary {
  const minMembers = options.minMembers ?? 3;
  const topN = options.topN ?? 5;
  const excludeST = options.excludeST ?? true;

  const groups = new Map<string, UniverseStock[]>();
  for (const stock of universe) {
    if (stock.sector === undefined || stock.changePct === undefined) {
      continue;
    }
    if (excludeST && isLikelySTName(stock.name)) {
      continue;
    }
    const list = groups.get(stock.sector) ?? [];
    list.push(stock);
    groups.set(stock.sector, list);
  }

  const heats: SectorHeat[] = [];
  for (const [sector, members] of groups) {
    if (members.length < minMembers) {
      continue;
    }
    const changeSum = members.reduce((sum, stock) => sum + (stock.changePct ?? 0), 0);
    heats.push({
      sector,
      memberCount: members.length,
      avgChangePct: changeSum / members.length,
      totalAmount: members.reduce((sum, stock) => sum + (stock.amount ?? 0), 0),
      limitUpCount: members.filter((stock) => classifyLimitState(stock.symbol, stock.changePct) === "limit_up").length,
    });
  }

  const byChangeDesc = [...heats].sort(
    (left, right) => right.avgChangePct - left.avgChangePct || left.sector.localeCompare(right.sector),
  );

  return {
    topGainers: byChangeDesc.slice(0, topN),
    topLosers: byChangeDesc.slice(-topN).reverse(),
    sectorCount: heats.length,
  };
}

/** Renders the 板块涨幅榜 line fed to the brain. "" when no sector data (graceful). */
export function renderSectorHeat(summary: SectorHeatSummary): string {
  if (summary.sectorCount === 0) {
    return "";
  }
  const fmt = (heat: SectorHeat): string =>
    `${heat.sector}${signedPct(heat.avgChangePct)}(${heat.memberCount}只${heat.limitUpCount > 0 ? `·${heat.limitUpCount}涨停` : ""})`;
  const lines = [`板块涨幅榜（${summary.sectorCount}个行业，均值口径）`];
  if (summary.topGainers.length > 0) {
    lines.push(`领涨：${summary.topGainers.map(fmt).join("、")}`);
  }
  if (summary.topLosers.length > 0) {
    lines.push(`领跌：${summary.topLosers.map(fmt).join("、")}`);
  }
  return lines.join("\n");
}

function signedPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}
