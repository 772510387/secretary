import {
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "../../domain/shared/index.js";
import { identifierSchema } from "../../domain/shared/index.js";

export const QMT_FAKE_BRIDGE_PROTOCOL_VERSION = "secretary.qmt.fake-bridge.v1";
export const QMT_FAKE_BRIDGE_RESULT_PREFIX = "SECRETARY_QMT_RESULT_JSON:";

export const qmtFakeBridgeCommandSchema = z.enum([
  "get_account_snapshot",
  "get_cash",
  "get_positions",
  "get_orders",
  "get_executions",
  "health_check",
]);

export type QmtFakeBridgeCommand = z.infer<typeof qmtFakeBridgeCommandSchema>;

export interface QmtFakeBridgeRequest {
  protocolVersion: typeof QMT_FAKE_BRIDGE_PROTOCOL_VERSION;
  requestId: string;
  command: QmtFakeBridgeCommand;
  accountRef?: string;
  payload: Record<string, JsonValue>;
  options: {
    timeoutMs: number;
    mode: "fake_read_only";
    allowNetwork: false;
    allowMiniQmt: false;
    allowBroker: false;
    allowOrders: false;
    allowAccountSecrets: false;
  };
}

export interface QmtFakeBridgeRunInput {
  requestId?: string;
  command: QmtFakeBridgeCommand;
  accountRef?: string;
  payload?: Record<string, JsonValue>;
  timeoutMs?: number;
}

export interface QmtFakeBridgeRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface QmtFakeSubprocessBridgeOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestIdGenerator?: () => string;
  killGraceMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  spawn?: QmtFakeBridgeSpawnLike;
}

export interface QmtFakeBridgeSubprocess {
  pid?: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type QmtFakeBridgeSpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => QmtFakeBridgeSubprocess;

export class QmtFakeBridgeError extends Error {
  readonly code?: string;

  constructor(message: string, options: { code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "QmtFakeBridgeError";
    this.code = options.code;
  }
}

export class QmtFakeSubprocessBridge {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestIdGenerator: () => string;
  private readonly killGraceMs: number;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly spawnProcess: QmtFakeBridgeSpawnLike;

  constructor(options: QmtFakeSubprocessBridgeOptions) {
    if (!options.command.trim()) {
      throw new QmtFakeBridgeError("QmtFakeSubprocessBridge command is required", {
        code: "missing_command",
      });
    }

    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestIdGenerator = options.requestIdGenerator
      ?? (() => `qmt-fake-${randomUUID()}`);
    this.killGraceMs = positiveInteger(options.killGraceMs, 1_000, "killGraceMs");
    this.stdoutLimitBytes = positiveInteger(options.stdoutLimitBytes, 1_000_000, "stdoutLimitBytes");
    this.stderrLimitBytes = positiveInteger(options.stderrLimitBytes, 64_000, "stderrLimitBytes");
    this.spawnProcess = options.spawn ?? nodeSpawn;
  }

  async run(
    input: QmtFakeBridgeRunInput,
    options: QmtFakeBridgeRunOptions = {},
  ): Promise<unknown> {
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? input.timeoutMs,
      1_000,
      "timeoutMs",
    );
    const request = createQmtFakeBridgeRequest(input, {
      requestId: input.requestId ?? this.requestIdGenerator(),
      timeoutMs,
    });
    const subprocess = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ?? { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return await this.collectResult(subprocess, request, {
      timeoutMs,
      signal: options.signal,
    });
  }

  private async collectResult(
    subprocess: QmtFakeBridgeSubprocess,
    request: QmtFakeBridgeRequest,
    options: Required<Pick<QmtFakeBridgeRunOptions, "timeoutMs">> & Pick<QmtFakeBridgeRunOptions, "signal">,
  ): Promise<unknown> {
    const stdout = createLimitedBuffer(this.stdoutLimitBytes);
    const stderr = createLimitedBuffer(this.stderrLimitBytes);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const stderrSuffix = () => formatStderr(stderr.toString());
    const timeoutError = () => new QmtFakeBridgeError(
      `QMT fake subprocess bridge timed out after ${options.timeoutMs}ms${stderrSuffix()}`,
      { code: "timeout" },
    );

    const terminate = (reason: "abort" | "timeout") => {
      terminateSubprocess(subprocess, {
        graceMs: this.killGraceMs,
        reason,
      });
    };

    return await new Promise((resolve, reject) => {
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;

        if (timeout) {
          clearTimeout(timeout);
        }

        options.signal?.removeEventListener("abort", onAbort);
        callback();
      };

      const onAbort = () => {
        terminate("abort");
        finish(() => reject(timeoutError()));
      };

      if (options.signal?.aborted) {
        onAbort();
        return;
      }

      timeout = setTimeout(() => {
        terminate("timeout");
        finish(() => reject(timeoutError()));
      }, options.timeoutMs);

      options.signal?.addEventListener("abort", onAbort, { once: true });

      subprocess.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.append(chunk);
      });
      subprocess.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.append(chunk);
      });
      subprocess.once("error", (error) => {
        finish(() => reject(new QmtFakeBridgeError(
          `QMT fake subprocess bridge failed to start: ${redactSecretText(error.message)}`,
          { code: "spawn_failed", cause: error },
        )));
      });
      subprocess.once("close", (code, signal) => {
        finish(() => {
          if (code !== 0) {
            reject(new QmtFakeBridgeError(
              `QMT fake subprocess bridge exited with code ${code ?? "null"}`
              + `${signal ? ` and signal ${signal}` : ""}${stderrSuffix()}`,
              { code: "non_zero_exit" },
            ));
            return;
          }

          try {
            resolve(parseQmtFakeBridgeOutput(stdout.toString(), {
              expectedRequestId: request.requestId,
              stderr: stderr.toString(),
            }));
          } catch (error) {
            reject(toQmtBridgeError(error, stderr.toString()));
          }
        });
      });

      if (!subprocess.stdin) {
        terminate("abort");
        finish(() => reject(new QmtFakeBridgeError(
          "QMT fake subprocess bridge stdin is not writable",
          { code: "stdin_unwritable" },
        )));
        return;
      }

      subprocess.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
    });
  }
}

export function createQmtFakeBridgeRequest(
  input: QmtFakeBridgeRunInput,
  options: {
    requestId: string;
    timeoutMs: number;
  },
): QmtFakeBridgeRequest {
  return {
    protocolVersion: QMT_FAKE_BRIDGE_PROTOCOL_VERSION,
    requestId: identifierSchema.parse(options.requestId),
    command: qmtFakeBridgeCommandSchema.parse(input.command),
    accountRef: input.accountRef === undefined
      ? undefined
      : identifierSchema.parse(input.accountRef),
    payload: sanitizePayload(input.payload ?? {}),
    options: {
      timeoutMs: positiveInteger(options.timeoutMs, 1_000, "timeoutMs"),
      mode: "fake_read_only",
      allowNetwork: false,
      allowMiniQmt: false,
      allowBroker: false,
      allowOrders: false,
      allowAccountSecrets: false,
    },
  };
}

export function parseQmtFakeBridgeOutput(
  stdout: string,
  options: {
    expectedRequestId?: string;
    stderr?: string;
  } = {},
): unknown {
  const rawJson = extractResultJson(stdout);
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawJson);
  } catch (error) {
    throw new QmtFakeBridgeError(
      `QMT fake subprocess bridge returned invalid JSON output${formatStderr(options.stderr)}`,
      { code: "invalid_json", cause: error },
    );
  }

  const record = asRecord(parsed);

  if (!record) {
    throw new QmtFakeBridgeError(
      `QMT fake subprocess bridge output must be a JSON object${formatStderr(options.stderr)}`,
      { code: "bad_output" },
    );
  }

  const protocolVersion = firstString(record.protocolVersion);

  if (protocolVersion && protocolVersion !== QMT_FAKE_BRIDGE_PROTOCOL_VERSION) {
    throw new QmtFakeBridgeError(
      `QMT fake subprocess bridge returned unsupported protocol ${protocolVersion}`,
      { code: "unsupported_protocol" },
    );
  }

  const requestId = firstString(record.requestId);

  if (options.expectedRequestId && requestId && requestId !== options.expectedRequestId) {
    throw new QmtFakeBridgeError(
      `QMT fake subprocess bridge returned mismatched requestId ${requestId}`,
      { code: "request_id_mismatch" },
    );
  }

  const status = firstString(record.status)?.toLowerCase();

  if (status && status !== "ok") {
    const message = firstString(record.error, record.message) ?? `status=${status}`;
    throw new QmtFakeBridgeError(
      `QMT fake subprocess bridge returned failed status: ${redactSecretText(message)}`
      + `${formatStderr(options.stderr)}`,
      { code: "failed_status" },
    );
  }

  if ("data" in record) {
    return record.data;
  }

  return record;
}

export function redactQmtFakeBridgeStderr(stderr: string): string {
  return redactSecretText(limitText(stderr, 4_000));
}

function extractResultJson(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const prefixedLine = [...lines]
    .reverse()
    .find((line) => line.trimStart().startsWith(QMT_FAKE_BRIDGE_RESULT_PREFIX));

  if (prefixedLine) {
    return prefixedLine
      .trimStart()
      .slice(QMT_FAKE_BRIDGE_RESULT_PREFIX.length)
      .trim();
  }

  const trimmed = stdout.trim();

  if (!trimmed) {
    throw new QmtFakeBridgeError("QMT fake subprocess bridge returned empty stdout", {
      code: "empty_stdout",
    });
  }

  return trimmed;
}

function terminateSubprocess(
  subprocess: QmtFakeBridgeSubprocess,
  options: {
    graceMs: number;
    reason: "abort" | "timeout";
  },
): void {
  const signal: NodeJS.Signals = options.reason === "timeout" ? "SIGTERM" : "SIGTERM";

  try {
    subprocess.kill(signal);
  } catch {
    // Best-effort termination. The promise path reports the timeout/abort.
  }

  setTimeout(() => {
    try {
      subprocess.kill("SIGKILL");
    } catch {
      // Ignore best-effort kill failures.
    }
  }, options.graceMs).unref?.();
}

function sanitizePayload(payload: Record<string, JsonValue>): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (isSecretLikeKey(key)) {
      output[key] = "<redacted>";
      continue;
    }

    output[key] = sanitizeJsonValue(value);
  }

  return output;
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return redactSecretText(value);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  const output: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(value)) {
    output[key] = isSecretLikeKey(key) ? "<redacted>" : sanitizeJsonValue(child);
  }

  return output;
}

function isSecretLikeKey(key: string): boolean {
  return /(account[_-]?secret|api[_-]?key|authorization|cookie|password|passwd|secret|token)/i.test(key);
}

function toQmtBridgeError(error: unknown, stderr: string): QmtFakeBridgeError {
  if (error instanceof QmtFakeBridgeError) {
    return error;
  }

  return new QmtFakeBridgeError(
    `QMT fake subprocess bridge failed: ${String(error)}${formatStderr(stderr)}`,
    { code: "bridge_failed", cause: error },
  );
}

function formatStderr(stderr: string | undefined): string {
  if (!stderr?.trim()) {
    return "";
  }

  return `; stderr: ${redactQmtFakeBridgeStderr(stderr)}`;
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(
      /(api[_-]?key|authorization|cookie|password|passwd|secret|token|account[_-]?secret)(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2<redacted>",
    )
    .replace(/(sk|ak|tk)-[A-Za-z0-9_-]{8,}/gi, "$1-<redacted>");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function createLimitedBuffer(limitBytes: number): {
  append: (chunk: Buffer | string) => void;
  toString: () => string;
} {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;

  return {
    append(chunk) {
      if (size >= limitBytes) {
        truncated = true;
        return;
      }

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = limitBytes - size;

      if (buffer.byteLength <= remaining) {
        chunks.push(buffer);
        size += buffer.byteLength;
        return;
      }

      chunks.push(buffer.subarray(0, remaining));
      size = limitBytes;
      truncated = true;
    },
    toString() {
      const text = Buffer.concat(chunks).toString("utf8");
      return truncated ? `${text}\n<output truncated>` : text;
    },
  };
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new QmtFakeBridgeError(`QmtFakeSubprocessBridge ${label} must be positive`, {
      code: "invalid_option",
    });
  }

  return value;
}

function limitText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength)}\n<stderr truncated>`;
}
