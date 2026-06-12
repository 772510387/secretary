import type { BeijingDateTime } from "./beijing-clock.js";

export type SchedulerJobRunStatus =
  | "completed"
  | "failed"
  | "skipped_locked"
  | "skipped_outside_session"
  | "skipped_stopped";

export interface SchedulerJobRun {
  jobId: string;
  status: SchedulerJobRunStatus;
  scheduledAt: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
}

export interface SchedulerTaskContext {
  jobId: string;
  scheduledAt: string;
  beijingTime: BeijingDateTime;
  signal: AbortSignal;
}

export type SchedulerTask = (context: SchedulerTaskContext) => void | Promise<void>;

export interface Clock {
  now(): Date;
}

export class SchedulerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchedulerError";
  }
}
