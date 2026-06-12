import { assertValidDate } from "./beijing-clock.js";
import { SchedulerError, type Clock, type SchedulerJobRun } from "./types.js";

export interface JobLockOptions {
  clock?: Clock;
}

export class JobLock {
  private readonly runningJobs = new Set<string>();
  private readonly clock: Clock;

  constructor(options: JobLockOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
  }

  isLocked(jobId: string): boolean {
    return this.runningJobs.has(normalizeJobId(jobId));
  }

  async runExclusive(
    jobId: string,
    task: () => void | Promise<void>,
    scheduledAt: Date = this.clock.now(),
  ): Promise<SchedulerJobRun> {
    const normalizedJobId = normalizeJobId(jobId);
    assertValidDate(scheduledAt);

    const startedAt = this.clock.now();
    assertValidDate(startedAt);

    if (this.runningJobs.has(normalizedJobId)) {
      return makeRun({
        jobId: normalizedJobId,
        status: "skipped_locked",
        scheduledAt,
        startedAt,
        finishedAt: startedAt,
      });
    }

    this.runningJobs.add(normalizedJobId);

    try {
      await task();
      const finishedAt = this.clock.now();
      assertValidDate(finishedAt);

      return makeRun({
        jobId: normalizedJobId,
        status: "completed",
        scheduledAt,
        startedAt,
        finishedAt,
      });
    } catch (error) {
      const finishedAt = this.clock.now();
      assertValidDate(finishedAt);

      return makeRun({
        jobId: normalizedJobId,
        status: "failed",
        scheduledAt,
        startedAt,
        finishedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.runningJobs.delete(normalizedJobId);
    }
  }
}

export function normalizeJobId(jobId: string): string {
  const normalized = jobId.trim();

  if (!normalized) {
    throw new SchedulerError("jobId must not be empty");
  }

  return normalized;
}

function makeRun(input: {
  jobId: string;
  status: SchedulerJobRun["status"];
  scheduledAt: Date;
  startedAt: Date;
  finishedAt: Date;
  error?: string;
}): SchedulerJobRun {
  return {
    jobId: input.jobId,
    status: input.status,
    scheduledAt: input.scheduledAt.toISOString(),
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    durationMs: Math.max(0, input.finishedAt.getTime() - input.startedAt.getTime()),
    error: input.error,
  };
}
