import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../domain/shared/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "./atomic-file-writer.js";
import { JsonStore } from "./json-store.js";

const runtimeStatusSchema = z.enum(["starting", "running", "degraded", "stopped", "failed"]);
const runtimeTaskStatusSchema = z.enum(["idle", "running", "stopped", "failed", "skipped"]);

export const runtimeErrorSummarySchema = z
  .object({
    errorType: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(500),
    occurredAt: isoDateTimeSchema,
  })
  .strict();

export const runtimeTaskHealthSchema = z
  .object({
    taskId: identifierSchema,
    status: runtimeTaskStatusSchema,
    lastStartedAt: isoDateTimeSchema.optional(),
    lastHeartbeatAt: isoDateTimeSchema.optional(),
    lastStoppedAt: isoDateTimeSchema.optional(),
    lastError: runtimeErrorSummarySchema.optional(),
  })
  .strict();

export const runtimeHealthSnapshotSchema = z
  .object({
    runtimeId: identifierSchema,
    status: runtimeStatusSchema,
    updatedAt: isoDateTimeSchema,
    startedAt: isoDateTimeSchema.optional(),
    stoppedAt: isoDateTimeSchema.optional(),
    heartbeatAt: isoDateTimeSchema.optional(),
    tasks: z.array(runtimeTaskHealthSchema),
    metadata: z.record(jsonValueSchema),
  })
  .strict();

export const runtimeHeartbeatSchema = z
  .object({
    heartbeatId: identifierSchema,
    runtimeId: identifierSchema,
    taskId: identifierSchema.optional(),
    status: runtimeTaskStatusSchema,
    occurredAt: isoDateTimeSchema,
    metadata: z.record(jsonValueSchema),
  })
  .strict();

export type RuntimeHealthStatus = z.infer<typeof runtimeStatusSchema>;
export type RuntimeTaskHealthStatus = z.infer<typeof runtimeTaskStatusSchema>;
export type RuntimeErrorSummary = z.infer<typeof runtimeErrorSummarySchema>;
export type RuntimeTaskHealth = z.infer<typeof runtimeTaskHealthSchema>;
export type RuntimeHealthSnapshot = z.infer<typeof runtimeHealthSnapshotSchema>;
export type RuntimeHeartbeat = z.infer<typeof runtimeHeartbeatSchema>;

export interface RuntimeHealthPaths {
  healthPath: string;
  heartbeatLogPath: string;
}

export interface RuntimeHealthStoreOptions {
  memoryDir: string;
  writer?: AtomicFileWriter;
  now?: () => Date;
  idGenerator?: () => string;
}

export interface RuntimeHealthWriteResult extends AtomicWriteResult {
  snapshot: RuntimeHealthSnapshot;
}

export interface RuntimeHeartbeatWriteResult extends AtomicWriteResult {
  heartbeat: RuntimeHeartbeat;
}

export type RuntimeHealthSnapshotInput = Omit<RuntimeHealthSnapshot, "metadata"> & {
  metadata?: Record<string, unknown>;
};

export type RuntimeHeartbeatInput = Omit<RuntimeHeartbeat, "heartbeatId" | "metadata"> & {
  heartbeatId?: string;
  metadata?: Record<string, unknown>;
};

export class RuntimeHealthStore {
  private readonly memoryDir: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;

  constructor(options: RuntimeHealthStoreOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? createDefaultIdGenerator();
  }

  paths(occurredAt: string = this.now().toISOString()): RuntimeHealthPaths {
    return createRuntimeHealthPaths(this.memoryDir, occurredAt);
  }

  readHealth(): RuntimeHealthSnapshot {
    const paths = this.paths();
    return new JsonStore({
      filePath: paths.healthPath,
      schema: runtimeHealthSnapshotSchema,
    }).read();
  }

  writeHealth(snapshotInput: RuntimeHealthSnapshotInput): RuntimeHealthWriteResult {
    const snapshot = runtimeHealthSnapshotSchema.parse({
      ...snapshotInput,
      metadata: sanitizeRuntimeHealthMetadata(snapshotInput.metadata),
    });
    const paths = this.paths(snapshot.updatedAt);
    const write = new JsonStore({
      filePath: paths.healthPath,
      schema: runtimeHealthSnapshotSchema,
      writer: this.writer,
    }).write(snapshot);

    return {
      ...write,
      snapshot,
    };
  }

  appendHeartbeat(input: RuntimeHeartbeatInput): RuntimeHeartbeatWriteResult {
    const heartbeat = runtimeHeartbeatSchema.parse({
      ...input,
      heartbeatId: input.heartbeatId ?? `heartbeat-${safeIdentifier(this.idGenerator())}`,
      metadata: sanitizeRuntimeHealthMetadata(input.metadata),
    });
    const paths = this.paths(heartbeat.occurredAt);
    const write = appendRuntimeHeartbeat(paths.heartbeatLogPath, heartbeat, this.writer);

    return {
      ...write,
      heartbeat,
    };
  }
}

export function createRuntimeHealthPaths(
  memoryDir: string,
  occurredAt: string,
): RuntimeHealthPaths {
  const logsDir = path.join(path.resolve(memoryDir), "logs");
  const date = occurredAt.slice(0, 10);

  return {
    healthPath: path.join(logsDir, "runtime-health.json"),
    heartbeatLogPath: path.join(logsDir, `heartbeat-${date}.jsonl`),
  };
}

export function appendRuntimeHeartbeat(
  filePath: string,
  heartbeatInput: RuntimeHeartbeat,
  writer: AtomicFileWriter = new AtomicFileWriter(),
): AtomicWriteResult {
  const heartbeat = runtimeHeartbeatSchema.parse(heartbeatInput);
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";

  return writer.write(filePath, `${previous}${separator}${JSON.stringify(heartbeat)}\n`);
}

export function summarizeRuntimeError(error: unknown, occurredAt: string): RuntimeErrorSummary {
  const errorLike = error instanceof Error ? error : undefined;
  const errorType = safeErrorType(errorLike?.name ?? typeof error);
  const message = redactRuntimeHealthText(errorLike?.message ?? String(error), 500);

  return runtimeErrorSummarySchema.parse({
    errorType,
    message: message || "Unknown runtime error",
    occurredAt,
  });
}

export function sanitizeRuntimeHealthMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(metadata ?? {})) {
    output[key] = isSensitiveRuntimeHealthKey(key)
      ? "[redacted]"
      : sanitizeRuntimeHealthValue(value);
  }

  return output;
}

function sanitizeRuntimeHealthValue(input: unknown): JsonValue {
  if (input === undefined) {
    return null;
  }

  if (input === null || typeof input === "number" || typeof input === "boolean") {
    return input as JsonValue;
  }

  if (typeof input === "string") {
    return redactRuntimeHealthText(input, 300);
  }

  if (Array.isArray(input)) {
    return input.slice(0, 20).map(sanitizeRuntimeHealthValue);
  }

  if (typeof input === "object") {
    const output: Record<string, JsonValue> = {};

    for (const [key, value] of Object.entries(input).slice(0, 50)) {
      output[key] = isSensitiveRuntimeHealthKey(key)
        ? "[redacted]"
        : sanitizeRuntimeHealthValue(value);
    }

    return output;
  }

  return "[unsupported]";
}

function redactRuntimeHealthText(input: string, maxLength: number): string {
  const redacted = input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|passwd|secret|token|account[_-]?id|brokerAccountId|account)\s*[:=]\s*[^,\s;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(sk|ak|tk)-[A-Za-z0-9_-]{8,}\b/gi, "$1-[redacted]");

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, maxLength - 14))}...[truncated]`;
}

function isSensitiveRuntimeHealthKey(key: string): boolean {
  return /(secret|token|password|passwd|api_?key|private_?key|credential|authorization|cookie|account)/i
    .test(key);
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

function safeErrorType(value: string): string {
  return safeIdentifier(value).slice(0, 128);
}
