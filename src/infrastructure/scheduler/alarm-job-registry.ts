import {
  formatBeijingMinute,
  parseBeijingTimeOfDay,
  toBeijingDateTime,
} from "./beijing-clock.js";
import { JobLock, normalizeJobId } from "./job-lock.js";
import type {
  Clock,
  SchedulerJobRun,
  SchedulerTask,
  SchedulerTaskContext,
} from "./types.js";
import { SchedulerError } from "./types.js";

export interface AlarmJob {
  jobId: string;
  beijingTime: string;
  task: SchedulerTask;
  weekdaysOnly?: boolean;
  description?: string;
}

export interface AlarmJobRegistryOptions {
  clock?: Clock;
  lock?: JobLock;
  signal?: AbortSignal;
}

export class AlarmJobRegistry {
  private readonly jobs = new Map<string, AlarmJob>();
  private readonly executedSlots = new Set<string>();
  private readonly clock: Clock;
  private readonly lock: JobLock;
  private readonly signal: AbortSignal;

  constructor(options: AlarmJobRegistryOptions = {}) {
    this.clock = options.clock ?? { now: () => new Date() };
    this.lock = options.lock ?? new JobLock({ clock: this.clock });
    this.signal = options.signal ?? new AbortController().signal;
  }

  register(job: AlarmJob): void {
    const jobId = normalizeJobId(job.jobId);
    const minute = parseBeijingTimeOfDay(job.beijingTime);

    if (this.jobs.has(jobId)) {
      throw new SchedulerError(`Alarm job already registered: ${jobId}`);
    }

    this.jobs.set(jobId, {
      ...job,
      jobId,
      beijingTime: formatBeijingMinute(minute),
    });
  }

  unregister(jobId: string): boolean {
    return this.jobs.delete(normalizeJobId(jobId));
  }

  listJobs(): AlarmJob[] {
    return [...this.jobs.values()];
  }

  async runDue(now: Date = this.clock.now()): Promise<SchedulerJobRun[]> {
    const beijingTime = toBeijingDateTime(now);
    const currentMinute = formatBeijingMinute(beijingTime.minuteOfDay);
    const runs: SchedulerJobRun[] = [];

    for (const job of this.jobs.values()) {
      if (job.beijingTime !== currentMinute) {
        continue;
      }

      if ((job.weekdaysOnly ?? false) && beijingTime.dayOfWeek > 5) {
        continue;
      }

      const slotKey = `${job.jobId}:${beijingTime.date}:${job.beijingTime}`;

      if (this.executedSlots.has(slotKey)) {
        continue;
      }

      const context: SchedulerTaskContext = {
        jobId: job.jobId,
        scheduledAt: now.toISOString(),
        beijingTime,
        signal: this.signal,
      };
      const run = await this.lock.runExclusive(job.jobId, () => job.task(context), now);

      if (run.status !== "skipped_locked") {
        this.executedSlots.add(slotKey);
      }

      runs.push(run);
    }

    return runs;
  }
}
