import { z } from "zod";
import { brainInputSchema, type BrainProvider } from "../domain/brain/index.js";
import {
  replayBiasSchema,
  replayDecisionSchema,
  type DecisionBasis,
  type DecisionStance,
  type ExperienceRangeBucket,
  type ReplayBias,
  type ReplayDecision,
  type SoftExperienceReport,
} from "../domain/decision/index.js";
import type {
  PointInTimeSnapshot,
  Position,
  SnapshotTechnical,
} from "../domain/portfolio/index.js";
import { bucketOf, findSoftLessonsByRegime, isExperienceUsableAt } from "./distill-experience.js";
import type { ReplayDecider } from "./replay-decider.js";

export interface ModelReplayDeciderOptions {
  /**
   * Prior-period soft experience surfaced to the model as an advisory hint. It is used
   * ONLY when its coverage ends strictly before the snapshot's asOfDate (the temporal
   * fence): a period's lessons can never inform its own past. Advisory only — the model
   * still decides, and nothing here changes a hard rule.
   */
  experience?: SoftExperienceReport;
}

/** Loose, per-stance schema for what the model returns in `structured`. */
const modelStanceSchema = z
  .object({
    symbol: z.string(),
    bias: replayBiasSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
    rationale: z.string().trim().min(1).max(500).optional(),
  })
  .passthrough();

interface ParsedModelStance {
  symbol: string;
  bias: ReplayBias;
  confidence?: number;
  rationale?: string;
}

/**
 * A model-driven replay decider (P1.1). The model proposes a per-holding stance
 * (increase/hold/reduce) from the snapshot's AS-OF context only — it never sees the
 * future, never executes, never writes the account.
 *
 * Safety is enforced by the backend, not trusted to the model: `executable: false`
 * and `reviewRequired: true` are hard-wired here regardless of what the model emits;
 * the factual `basis` is taken from the snapshot (not the model); any model failure,
 * malformed output, or omitted symbol falls back to a low-confidence `hold` — it can
 * never crash the replay or escalate a decision.
 */
export class ModelReplayDecider implements ReplayDecider {
  private readonly experience?: SoftExperienceReport;

  constructor(
    private readonly brainProvider: BrainProvider,
    options: ModelReplayDeciderOptions = {},
  ) {
    this.experience = options.experience;
  }

  async decide(snapshot: PointInTimeSnapshot): Promise<ReplayDecision> {
    const modelStances = await this.askModel(snapshot);
    const technicalBySymbol = new Map(
      snapshot.market.technicals.map((technical) => [technical.symbol, technical]),
    );

    const stances: DecisionStance[] = snapshot.positions.map((position) => {
      const basis = buildBasis(technicalBySymbol.get(position.symbol) ?? null, snapshot, position.symbol);
      const proposed = modelStances.get(position.symbol);
      if (proposed === undefined) {
        return holdStance(position, basis, "模型未给出该标的判断，默认保持。");
      }
      return {
        symbol: position.symbol,
        market: position.market,
        name: position.name,
        bias: proposed.bias,
        confidence: proposed.confidence ?? 0.5,
        rationale: proposed.rationale ?? defaultRationale(proposed.bias),
        basis,
      };
    });

    return replayDecisionSchema.parse({
      schemaVersion: 1,
      decisionId: snapshot.snapshotId.replace(/^snap-/, "dec-"),
      snapshotId: snapshot.snapshotId,
      accountId: snapshot.accountId,
      alarmId: snapshot.alarmId,
      asOfDate: snapshot.asOfDate,
      asOfTime: snapshot.asOfTime,
      stances,
      // Hard-wired safety: nothing the model returns can flip these.
      executable: false,
      reviewRequired: true,
      generatedBy: "model-replay-decider",
    });
  }

  /**
   * Builds the advisory soft-experience hint for this snapshot — but ONLY if the
   * experience clears the temporal fence (its coverage ended strictly before the
   * snapshot's asOfDate). Otherwise returns "" so no future-derived lesson leaks back.
   */
  private experienceHintFor(snapshot: PointInTimeSnapshot): string {
    const experience = this.experience;
    if (experience === undefined || !isExperienceUsableAt(experience, snapshot.asOfDate)) {
      return "";
    }

    const technicalBySymbol = new Map(
      snapshot.market.technicals.map((technical) => [technical.symbol, technical]),
    );
    const lines: string[] = [];
    for (const position of snapshot.positions) {
      const technical = technicalBySymbol.get(position.symbol);
      if (technical === undefined) {
        continue;
      }
      const lessons = findSoftLessonsByRegime(experience, {
        trend: technical.trend,
        rangePosition60: technical.rangePosition60,
      });
      if (lessons.length === 0) {
        continue;
      }
      const parts = lessons.map(
        (lesson) =>
          `${BIAS_LABEL[lesson.regime.bias]}命中率${pct(lesson.hitRate)}(样本${lesson.sampleSize}，${lesson.verdict})`,
      );
      lines.push(
        `- ${position.symbol}（形态：${TREND_LABEL[technical.trend]}·${BUCKET_LABEL[bucketOf(technical.rangePosition60)]}）历史：${parts.join("；")}`,
      );
    }

    if (lines.length === 0) {
      return "";
    }
    return [
      "",
      `【历史软经验（截至 ${experience.coverageThroughDate}，早于本时点），仅供参考、非硬性规则，最终仍由你判断】`,
      ...lines,
    ].join("\n");
  }

  private async askModel(snapshot: PointInTimeSnapshot): Promise<Map<string, ParsedModelStance>> {
    const result = new Map<string, ParsedModelStance>();
    try {
      const output = await this.brainProvider.generate(this.buildBrainInput(snapshot));
      const structured = output.structured as { stances?: unknown } | null | undefined;
      const items = structured && Array.isArray(structured.stances) ? structured.stances : [];
      for (const item of items) {
        const parsed = modelStanceSchema.safeParse(item);
        if (parsed.success) {
          result.set(parsed.data.symbol, parsed.data);
        }
      }
    } catch {
      // Any model/transport failure -> empty map -> all positions fall back to hold.
    }
    return result;
  }

  private buildBrainInput(snapshot: PointInTimeSnapshot) {
    const held = snapshot.positions.map((position) => `${position.symbol}(${position.name})`);
    return brainInputSchema.parse({
      requestId: `replay-decide-${snapshot.snapshotId}`.slice(0, 128),
      taskType: "user_query",
      prompt: [
        "你是只读的复盘决策器。基于给定的【某一时点 as-of】账户、持仓、技术指标快照，",
        "对每个持仓给出操作倾向：increase（加配）/ hold（保持）/ reduce（减配）。",
        "只能依据 context 里这个时点及更早的信息，绝不能假设任何未来走势。",
        "你只产出结构化判断，不下单、不写账户、不改规则——这些只是待人工复核的建议。",
        "在输出 JSON 的 structured 字段放：",
        '{"stances":[{"symbol":"6位代码","bias":"increase|hold|reduce","confidence":0到1,"rationale":"一句话中文理由"}]}',
        `需要判断的持仓：${held.length > 0 ? held.join("、") : "（无）"}`,
        this.experienceHintFor(snapshot),
      ]
        .filter((line) => line !== "")
        .join("\n"),
      context: {
        asOf: snapshot.asOfTime,
        asOfDate: snapshot.asOfDate,
        snapshot: snapshot.brainContext,
      },
      constraints: {
        locale: "zh-CN",
        timezone: "Asia/Shanghai",
        outputFormat: "json",
        toolPermissions: [],
      },
      createdAt: snapshot.asOfTime,
    });
  }
}

function buildBasis(
  technical: SnapshotTechnical | null,
  snapshot: PointInTimeSnapshot,
  symbol: string,
): DecisionBasis {
  if (technical === null) {
    return { trend: "insufficient_data", technicalAsOfDate: null, rangePosition60: null, closeVsMa20: null };
  }
  const asOfClose = snapshot.market.prices[symbol] ?? null;
  const closeVsMa20 =
    technical.ma20 !== null && technical.ma20 > 0 && asOfClose !== null
      ? round6((asOfClose - technical.ma20) / technical.ma20)
      : null;
  return {
    trend: technical.trend,
    technicalAsOfDate: technical.asOfDate,
    rangePosition60: technical.rangePosition60,
    closeVsMa20,
  };
}

function holdStance(position: Position, basis: DecisionBasis, rationale: string): DecisionStance {
  return {
    symbol: position.symbol,
    market: position.market,
    name: position.name,
    bias: "hold",
    confidence: 0.3,
    rationale,
    basis,
  };
}

function defaultRationale(bias: ReplayBias): string {
  if (bias === "increase") {
    return "模型建议加配（未给理由）。";
  }
  if (bias === "reduce") {
    return "模型建议减配（未给理由）。";
  }
  return "模型建议保持（未给理由）。";
}

const TREND_LABEL: Record<SnapshotTechnical["trend"], string> = {
  uptrend: "上涨",
  downtrend: "下跌",
  sideways: "震荡",
  insufficient_data: "数据不足",
};
const BUCKET_LABEL: Record<ExperienceRangeBucket, string> = {
  low: "低位",
  mid: "中位",
  high: "高位",
  near_high: "逼近高位",
  unknown: "位置未知",
};
const BIAS_LABEL: Record<ReplayBias, string> = {
  increase: "加配",
  hold: "保持",
  reduce: "减配",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(2)}%`;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
