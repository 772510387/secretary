import path from "node:path";
import {
  auditEventSchema,
  type AuditEvent,
} from "../domain/audit/index.js";
import {
  appendAuditEvent,
} from "../infrastructure/logging/index.js";
import {
  GracefulShutdown,
  type Clock,
  type SchedulerTask,
  type SchedulerTaskContext,
  type TradingSessionOptions,
} from "../infrastructure/scheduler/index.js";
import {
  RuntimeHealthStore,
  summarizeRuntimeError,
  type RuntimeErrorSummary,
  type RuntimeHealthSnapshot,
  type RuntimeHeartbeatWriteResult,
  type RuntimeHealthWriteResult,
  type AtomicWriteResult,
} from "../infrastructure/storage/index.js";
import {
  createSchedulerRuntime,
  type SchedulerRuntime,
} from "./scheduler-runtime.js";

export type MarketSentinelDaemonState = "idle" | "running" | "stopped";

export interface MarketSentinelDaemonStartResult {
  status: "started" | "already_started";
  jobId: string;
  startedAt: string;
  auditLogPath: string;
  auditBackupPath?: string;
  healthPath: string;
  healthBackupPath?: string;
  heartbeatLogPath: string;
  heartbeatBackupPath?: string;
}

export interface MarketSentinelDaemonStopResult {
  status: "stopped" | "not_started";
  jobId: string;
  stoppedAt: string;
  auditLogPath: string;
  auditBackupPath?: string;
  healthPath: string;
  healthBackupPath?: string;
  heartbeatLogPath: string;
  heartbeatBackupPath?: string;
  shutdownHookCount: number;
  failedShutdownHookCount: number;
}

interface MarketSentinelDaemonHealthWrite {
  health: RuntimeHealthWriteResult;
  heartbeat: RuntimeHeartbeatWriteResult;
}

export type MarketSentinelDaemonAuditAppender = (
  filePath: string,
  event: AuditEvent,
) => AtomicWriteResult;

export interface MarketSentinelDaemonOptions {
  memoryDir: string;
  runtime?: SchedulerRuntime;
  shutdown?: GracefulShutdown;
  clock?: Clock;
  task?: SchedulerTask;
  jobId?: string;
  intervalMs?: number;
  outsideSessionIntervalMs?: number;
  tradingSession?: TradingSessionOptions;
  auditAppender?: MarketSentinelDaemonAuditAppender;
  healthStore?: RuntimeHealthStore;
  idGenerator?: () => string;
}

export class MarketSentinelDaemonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketSentinelDaemonError";
  }
}

export class MarketSentinelDaemon {
  private readonly memoryDir: string;
  private readonly runtime: SchedulerRuntime;
  private readonly jobId: string;
  private readonly auditAppender: MarketSentinelDaemonAuditAppender;
  private readonly healthStore: RuntimeHealthStore;
  private readonly idGenerator: () => string;
  private readonly runner: ReturnType<SchedulerRuntime["createMarketSentinelRunner"]>;
  private state: MarketSentinelDaemonState = "idle";
  private startedAt?: string;
  private stoppedAt?: string;
  private lastHeartbeatAt?: string;
  private lastError?: RuntimeErrorSummary;

  constructor(options: MarketSentinelDaemonOptions) {
    const memoryDir = options.memoryDir.trim();

    if (!memoryDir) {
      throw new MarketSentinelDaemonError("memoryDir must not be empty");
    }

    this.memoryDir = path.resolve(memoryDir);
    this.runtime =
      options.runtime ??
      createSchedulerRuntime({
        clock: options.clock,
        shutdown: options.shutdown,
    });
    this.jobId = options.jobId?.trim() || "market-sentinel-dev";
    this.auditAppender = options.auditAppender ?? appendAuditEvent;
    this.idGenerator = options.idGenerator ?? createDefaultIdGenerator();
    this.healthStore =
      options.healthStore ??
      new RuntimeHealthStore({
        memoryDir: this.memoryDir,
        now: () => this.runtime.clock.now(),
        idGenerator: this.idGenerator,
      });
    this.runner = this.runtime.createMarketSentinelRunner({
      jobId: this.jobId,
      intervalMs: options.intervalMs,
      outsideSessionIntervalMs: options.outsideSessionIntervalMs,
      tradingSession: options.tradingSession,
      task: this.wrapTask(options.task ?? defaultMockMarketSentinelTask),
    });
  }

  start(): MarketSentinelDaemonStartResult {
    const occurredAt = this.nowIso();

    if (this.state === "running") {
      const health = this.recordHealth({
        occurredAt,
        runtimeStatus: "running",
        taskStatus: "running",
        event: "start_skipped_already_running",
      });
      const audit = this.writeLifecycleAudit({
        occurredAt,
        result: "skipped",
        severity: "warning",
        message: "MarketSentinel daemon start skipped because it is already running",
        metadata: {
          state: this.state,
        },
      });

      return {
        status: "already_started",
        jobId: this.jobId,
        startedAt: occurredAt,
        auditLogPath: audit.filePath,
        auditBackupPath: audit.backupPath,
        ...healthWritePaths(health),
      };
    }

    if (this.state === "stopped") {
      throw new MarketSentinelDaemonError(
        "MarketSentinel daemon cannot be restarted after stop; create a new daemon instance",
      );
    }

    try {
      this.runner.start();
      this.state = "running";
      this.startedAt = occurredAt;
      this.stoppedAt = undefined;
      const health = this.recordHealth({
        occurredAt,
        runtimeStatus: "running",
        taskStatus: "running",
        event: "started",
      });
      const audit = this.writeLifecycleAudit({
        occurredAt,
        result: "success",
        severity: "info",
        message: "MarketSentinel daemon started",
        metadata: {
          state: this.state,
        },
      });

      return {
        status: "started",
        jobId: this.jobId,
        startedAt: occurredAt,
        auditLogPath: audit.filePath,
        auditBackupPath: audit.backupPath,
        ...healthWritePaths(health),
      };
    } catch (error) {
      const summary = summarizeRuntimeError(error, occurredAt);
      this.lastError = summary;
      this.recordHealth({
        occurredAt,
        runtimeStatus: "failed",
        taskStatus: "failed",
        event: "start_failed",
      });
      this.writeLifecycleAudit({
        occurredAt,
        result: "failure",
        severity: "critical",
        message: "MarketSentinel daemon failed to start",
        metadata: {
          state: this.state,
          errorType: summary.errorType,
          error: summary.message,
        },
      });
      throw error;
    }
  }

  async stop(reason = "manual"): Promise<MarketSentinelDaemonStopResult> {
    const occurredAt = this.nowIso();

    if (this.state !== "running") {
      this.stoppedAt = occurredAt;
      const health = this.recordHealth({
        occurredAt,
        runtimeStatus: "stopped",
        taskStatus: "stopped",
        event: "stop_skipped_not_running",
      });
      const audit = this.writeLifecycleAudit({
        occurredAt,
        result: "skipped",
        severity: "warning",
        message: "MarketSentinel daemon stop skipped because it is not running",
        metadata: {
          state: this.state,
          reason,
        },
      });

      return {
        status: "not_started",
        jobId: this.jobId,
        stoppedAt: occurredAt,
        auditLogPath: audit.filePath,
        auditBackupPath: audit.backupPath,
        ...healthWritePaths(health),
        shutdownHookCount: 0,
        failedShutdownHookCount: 0,
      };
    }

    const shutdown = await this.runtime.shutdown.shutdown(reason);
    this.state = "stopped";
    this.stoppedAt = shutdown.finishedAt;
    const failedShutdownHookCount = shutdown.hooks.filter((hook) => hook.status === "failed").length;
    const health = this.recordHealth({
      occurredAt: shutdown.finishedAt,
      runtimeStatus: "stopped",
      taskStatus: "stopped",
      event: failedShutdownHookCount > 0 ? "stopped_with_failed_hooks" : "stopped",
      metadata: {
        shutdownHookCount: shutdown.hooks.length,
        failedShutdownHookCount,
      },
    });
    const audit = this.writeLifecycleAudit({
      occurredAt: this.nowIso(),
      result: failedShutdownHookCount > 0 ? "failure" : "success",
      severity: failedShutdownHookCount > 0 ? "critical" : "info",
      message: failedShutdownHookCount > 0
        ? "MarketSentinel daemon stopped with failed shutdown hooks"
        : "MarketSentinel daemon stopped",
      metadata: {
        state: this.state,
        reason,
        shutdownHookCount: shutdown.hooks.length,
        failedShutdownHookCount,
      },
    });

    return {
      status: "stopped",
      jobId: this.jobId,
      stoppedAt: shutdown.finishedAt,
      auditLogPath: audit.filePath,
      auditBackupPath: audit.backupPath,
      ...healthWritePaths(health),
      shutdownHookCount: shutdown.hooks.length,
      failedShutdownHookCount,
    };
  }

  isStarted(): boolean {
    return this.state === "running" && this.runner.isStarted();
  }

  getState(): MarketSentinelDaemonState {
    return this.state;
  }

  pendingRunCount(): number {
    return this.runner.pendingRunCount();
  }

  health(): RuntimeHealthSnapshot {
    return this.healthStore.readHealth();
  }

  private wrapTask(task: SchedulerTask): SchedulerTask {
    return async (context) => {
      try {
        await task(context);
        this.recordHealth({
          occurredAt: this.nowIso(),
          runtimeStatus: "running",
          taskStatus: "running",
          event: "task_completed",
          metadata: {
            scheduledAt: context.scheduledAt,
            beijingDate: context.beijingTime.date,
            beijingTime: context.beijingTime.time,
          },
        });
        this.writeRunAudit(context, {
          result: "success",
          severity: "debug",
          message: "MarketSentinel daemon task completed",
        });
      } catch (error) {
        const occurredAt = this.nowIso();
        const summary = summarizeRuntimeError(error, occurredAt);
        this.lastError = summary;
        this.recordHealth({
          occurredAt,
          runtimeStatus: "degraded",
          taskStatus: "failed",
          event: "task_failed",
          metadata: {
            scheduledAt: context.scheduledAt,
            beijingDate: context.beijingTime.date,
            beijingTime: context.beijingTime.time,
            errorType: summary.errorType,
          },
        });
        this.writeRunAudit(context, {
          result: "failure",
          severity: "warning",
          message: "MarketSentinel daemon task failed",
          metadata: {
            errorType: summary.errorType,
            error: summary.message,
          },
        });
        throw error;
      }
    };
  }

  private recordHealth(input: {
    occurredAt: string;
    runtimeStatus: RuntimeHealthSnapshot["status"];
    taskStatus: RuntimeHealthSnapshot["tasks"][number]["status"];
    event: string;
    metadata?: Record<string, unknown>;
  }): MarketSentinelDaemonHealthWrite {
    this.lastHeartbeatAt = input.occurredAt;
    const baseMetadata = {
      jobId: this.jobId,
      mode: "development",
      taskMode: "mock",
      liveTrading: false,
      brokerConnected: false,
      brainProvider: "mock",
      networkAllowed: false,
      directExecutionAllowed: false,
      event: input.event,
      pendingRunCount: this.pendingRunCount(),
      ...input.metadata,
    };
    const heartbeat = this.healthStore.appendHeartbeat({
      runtimeId: "market-sentinel-daemon",
      taskId: this.jobId,
      status: input.taskStatus,
      occurredAt: input.occurredAt,
      metadata: baseMetadata,
    });
    const health = this.healthStore.writeHealth({
      runtimeId: "market-sentinel-daemon",
      status: input.runtimeStatus,
      updatedAt: input.occurredAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      heartbeatAt: this.lastHeartbeatAt,
      tasks: [
        {
          taskId: this.jobId,
          status: input.taskStatus,
          lastStartedAt: this.startedAt,
          lastHeartbeatAt: this.lastHeartbeatAt,
          lastStoppedAt: this.stoppedAt,
          lastError: this.lastError,
        },
      ],
      metadata: baseMetadata,
    });

    return { health, heartbeat };
  }

  private writeLifecycleAudit(input: {
    occurredAt: string;
    result: AuditEvent["result"];
    severity: AuditEvent["severity"];
    message: string;
    metadata?: Record<string, unknown>;
  }): AtomicWriteResult {
    return this.writeAudit({
      occurredAt: input.occurredAt,
      action: input.result === "failure" ? "error" : "config",
      severity: input.severity,
      result: input.result,
      message: input.message,
      metadata: input.metadata,
    });
  }

  private writeRunAudit(
    context: SchedulerTaskContext,
    input: {
      result: AuditEvent["result"];
      severity: AuditEvent["severity"];
      message: string;
      metadata?: Record<string, unknown>;
    },
  ): AtomicWriteResult {
    return this.writeAudit({
      occurredAt: this.nowIso(),
      action: input.result === "failure" ? "error" : "validate",
      severity: input.severity,
      result: input.result,
      message: input.message,
      correlationId: context.jobId,
      metadata: {
        scheduledAt: context.scheduledAt,
        beijingDate: context.beijingTime.date,
        beijingTime: context.beijingTime.time,
        ...input.metadata,
      },
    });
  }

  private writeAudit(input: {
    occurredAt: string;
    action: AuditEvent["action"];
    severity: AuditEvent["severity"];
    result: AuditEvent["result"];
    message: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  }): AtomicWriteResult {
    const event = auditEventSchema.parse({
      eventId: `audit-sentinel-${safeIdentifier(this.idGenerator())}`,
      occurredAt: input.occurredAt,
      actor: {
        type: "scheduler",
        id: "market-sentinel-daemon",
      },
      action: input.action,
      subject: {
        type: "scheduler",
        id: safeIdentifier(this.jobId),
      },
      severity: input.severity,
      result: input.result,
      message: input.message,
      correlationId: input.correlationId ? safeIdentifier(input.correlationId) : undefined,
      metadata: {
        jobId: this.jobId,
        mode: "development",
        taskMode: "mock",
        liveTrading: false,
        brokerConnected: false,
        brainProvider: "mock",
        networkAllowed: false,
        directExecutionAllowed: false,
        ...input.metadata,
      },
    });

    return this.auditAppender(this.auditLogPath(input.occurredAt), event);
  }

  private auditLogPath(occurredAt: string): string {
    return path.join(this.memoryDir, "logs", `audit-${occurredAt.slice(0, 10)}.jsonl`);
  }

  private nowIso(): string {
    return this.runtime.clock.now().toISOString();
  }
}

export function createMarketSentinelDaemon(
  options: MarketSentinelDaemonOptions,
): MarketSentinelDaemon {
  return new MarketSentinelDaemon(options);
}

export async function defaultMockMarketSentinelTask(
  _context: SchedulerTaskContext,
): Promise<void> {
  // Development daemon smoke only. Real market/LLM/broker wiring must be injected explicitly later.
}

function createDefaultIdGenerator(): () => string {
  let counter = 0;

  return () => {
    counter += 1;
    return `${Date.now()}-${counter}`;
  };
}

function safeIdentifier(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "id-")
    .slice(0, 128);

  return normalized || "id";
}

function healthWritePaths(write: MarketSentinelDaemonHealthWrite): {
  healthPath: string;
  healthBackupPath?: string;
  heartbeatLogPath: string;
  heartbeatBackupPath?: string;
} {
  return {
    healthPath: write.health.filePath,
    healthBackupPath: write.health.backupPath,
    heartbeatLogPath: write.heartbeat.filePath,
    heartbeatBackupPath: write.heartbeat.backupPath,
  };
}
