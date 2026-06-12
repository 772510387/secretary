import {
  assertValidDate,
  toBeijingDateTime,
} from "./beijing-clock.js";
import { JobLock, normalizeJobId } from "./job-lock.js";
import {
  isWithinTradingSession,
  type TradingSessionOptions,
} from "./trading-session.js";
import {
  SchedulerError,
  type Clock,
  type SchedulerJobRun,
  type SchedulerTask,
  type SchedulerTaskContext,
} from "./types.js";

export interface MarketSentinelRunnerOptions {
  task: SchedulerTask;
  jobId?: string;
  intervalMs?: number;
  outsideSessionIntervalMs?: number;
  clock?: Clock;
  lock?: JobLock;
  signal?: AbortSignal;
  tradingSession?: TradingSessionOptions;
}

export class MarketSentinelRunner {
  private readonly task: SchedulerTask;
  private readonly jobId: string;
  private readonly intervalMs: number;
  private readonly outsideSessionIntervalMs: number;
  private readonly clock: Clock;
  private readonly lock: JobLock;
  private readonly tradingSession: TradingSessionOptions;
  private readonly controller = new AbortController();
  private readonly pendingRuns = new Set<Promise<SchedulerJobRun>>();
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(options: MarketSentinelRunnerOptions) {
    this.task = options.task;
    this.jobId = normalizeJobId(options.jobId ?? "market-sentinel");
    this.intervalMs = normalizeInterval(options.intervalMs ?? 3000, "intervalMs");
    this.outsideSessionIntervalMs = normalizeInterval(
      options.outsideSessionIntervalMs ?? 60_000,
      "outsideSessionIntervalMs",
    );
    this.clock = options.clock ?? { now: () => new Date() };
    this.lock = options.lock ?? new JobLock({ clock: this.clock });
    this.tradingSession = options.tradingSession ?? {};

    if (options.signal?.aborted) {
      this.controller.abort(options.signal.reason);
    } else {
      options.signal?.addEventListener("abort", () => void this.stop(), { once: true });
    }
  }

  start(): void {
    if (this.controller.signal.aborted) {
      throw new SchedulerError(`Cannot start stopped runner: ${this.jobId}`);
    }

    if (this.started) {
      return;
    }

    this.started = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.started = false;

    if (!this.controller.signal.aborted) {
      this.controller.abort("stopped");
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    await Promise.allSettled([...this.pendingRuns]);
  }

  async triggerOnce(scheduledAt: Date = this.clock.now()): Promise<SchedulerJobRun> {
    assertValidDate(scheduledAt);

    if (this.controller.signal.aborted) {
      return makeSkippedRun(this.jobId, "skipped_stopped", scheduledAt, this.clock.now());
    }

    if (!isWithinTradingSession(scheduledAt, this.tradingSession)) {
      return makeSkippedRun(this.jobId, "skipped_outside_session", scheduledAt, this.clock.now());
    }

    const context: SchedulerTaskContext = {
      jobId: this.jobId,
      scheduledAt: scheduledAt.toISOString(),
      beijingTime: toBeijingDateTime(scheduledAt),
      signal: this.controller.signal,
    };

    return this.lock.runExclusive(this.jobId, () => this.task(context), scheduledAt);
  }

  isStarted(): boolean {
    return this.started;
  }

  pendingRunCount(): number {
    return this.pendingRuns.size;
  }

  private tick(): void {
    if (!this.started || this.controller.signal.aborted) {
      return;
    }

    const scheduledAt = this.clock.now();
    const runPromise = this.triggerOnce(scheduledAt).catch((error) =>
      makeFailedRun(this.jobId, scheduledAt, this.clock.now(), error),
    );

    this.pendingRuns.add(runPromise);
    void runPromise.finally(() => {
      this.pendingRuns.delete(runPromise);
    });

    this.scheduleNext(this.nextDelayMs(scheduledAt));
  }

  private scheduleNext(delayMs: number): void {
    if (!this.started || this.controller.signal.aborted) {
      return;
    }

    this.timer = setTimeout(() => this.tick(), delayMs);
  }

  private nextDelayMs(date: Date): number {
    return isWithinTradingSession(date, this.tradingSession)
      ? this.intervalMs
      : this.outsideSessionIntervalMs;
  }
}

function normalizeInterval(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SchedulerError(`${name} must be a positive integer`);
  }

  return value;
}

function makeSkippedRun(
  jobId: string,
  status: "skipped_outside_session" | "skipped_stopped",
  scheduledAt: Date,
  observedAt: Date,
): SchedulerJobRun {
  return {
    jobId,
    status,
    scheduledAt: scheduledAt.toISOString(),
    startedAt: observedAt.toISOString(),
    finishedAt: observedAt.toISOString(),
    durationMs: 0,
  };
}

function makeFailedRun(
  jobId: string,
  scheduledAt: Date,
  observedAt: Date,
  error: unknown,
): SchedulerJobRun {
  return {
    jobId,
    status: "failed",
    scheduledAt: scheduledAt.toISOString(),
    startedAt: observedAt.toISOString(),
    finishedAt: observedAt.toISOString(),
    durationMs: 0,
    error: error instanceof Error ? error.message : String(error),
  };
}
