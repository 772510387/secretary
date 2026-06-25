import { toBeijingDateTime } from "../infrastructure/scheduler/index.js";

export type BudgetKind = "brain" | "research" | "search";

export interface DailyBudgetLimits {
  /** Max brain analysis calls per Beijing day (alarms + sentinel wake). undefined = unlimited. */
  brain?: number;
  /** Max deep-research (TradingAgents-CN) runs per day. */
  research?: number;
  /** Max web searches per day. */
  search?: number;
}

export interface DailyBudgetSnapshot {
  date: string;
  used: Record<BudgetKind, number>;
  limits: DailyBudgetLimits;
}

const KINDS: readonly BudgetKind[] = ["brain", "research", "search"];

/**
 * A per-Beijing-day spend cap for the autonomous daemons, so an always-on
 * process can't run away on token cost overnight (e.g. deep_review looping over
 * holdings every night). Counters reset at the Beijing date boundary. A kind with
 * no configured limit is unlimited. Purely a guard — it never spends anything.
 */
export class DailyBudget {
  private date: string;
  private used: Record<BudgetKind, number> = { brain: 0, research: 0, search: 0 };

  constructor(
    private readonly limits: DailyBudgetLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.date = this.today();
  }

  /** Consume `count` units if within the limit; returns false (and consumes nothing) if it would exceed. */
  tryConsume(kind: BudgetKind, count = 1): boolean {
    this.roll();
    const limit = this.limits[kind];

    if (limit !== undefined && this.used[kind] + count > limit) {
      return false;
    }

    this.used[kind] += count;
    return true;
  }

  remaining(kind: BudgetKind): number {
    this.roll();
    const limit = this.limits[kind];
    return limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, limit - this.used[kind]);
  }

  snapshot(): DailyBudgetSnapshot {
    this.roll();
    return { date: this.date, used: { ...this.used }, limits: this.limits };
  }

  private today(): string {
    return toBeijingDateTime(this.now()).date;
  }

  private roll(): void {
    const today = this.today();
    if (today !== this.date) {
      this.date = today;
      for (const kind of KINDS) {
        this.used[kind] = 0;
      }
    }
  }
}
