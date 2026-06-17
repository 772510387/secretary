import {
  spawn as nodeSpawn,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../domain/shared/index.js";
import {
  validateResearchTask,
  type ResearchTask,
} from "../../domain/research/index.js";
import {
  ResearchProviderError,
} from "./errors.js";
import type {
  TradingAgentsCnRunner,
  TradingAgentsCnRunnerContext,
} from "./trading-agents-cn-adapter.js";

export const TRADING_AGENTS_CN_RUNNER_PROTOCOL_VERSION =
  "secretary.tradingagents-cn.runner.v1";
export const TRADING_AGENTS_CN_RESULT_PREFIX = "SECRETARY_RESULT_JSON:";

export interface TradingAgentsCnSubprocessRunnerOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestIdGenerator?: (task: ResearchTask) => string;
  killGraceMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  spawn?: TradingAgentsCnSpawnLike;
}

export interface TradingAgentsCnSubprocessRequest {
  protocolVersion: typeof TRADING_AGENTS_CN_RUNNER_PROTOCOL_VERSION;
  requestId: string;
  task: {
    taskId: string;
    symbol: string;
    market: ResearchTask["market"];
    name?: string;
    tradingDate: string;
    objective: string;
    context: JsonValue;
    createdAt: string;
  };
  options: {
    timeoutMs: number;
    locale: "zh-CN";
    mode: "paper_research";
    allowNetwork: false;
    allowBroker: false;
    allowOrders: false;
  };
}

export interface TradingAgentsCnSubprocessProcess {
  pid?: number;
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
}

export type TradingAgentsCnSpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => TradingAgentsCnSubprocessProcess;

export class TradingAgentsCnSubprocessRunner {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  private readonly requestIdGenerator: (task: ResearchTask) => string;
  private readonly killGraceMs: number;
  private readonly stdoutLimitBytes: number;
  private readonly stderrLimitBytes: number;
  private readonly spawnProcess: TradingAgentsCnSpawnLike;

  constructor(options: TradingAgentsCnSubprocessRunnerOptions) {
    if (!options.command.trim()) {
      throw new ResearchProviderError("TradingAgentsCnSubprocessRunner command is required");
    }

    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.env = options.env;
    this.requestIdGenerator = options.requestIdGenerator
      ?? ((task) => `research-run-${safeId(task.taskId)}-${randomUUID()}`);
    this.killGraceMs = positiveInteger(options.killGraceMs, 1_000, "killGraceMs");
    this.stdoutLimitBytes = positiveInteger(options.stdoutLimitBytes, 1_000_000, "stdoutLimitBytes");
    this.stderrLimitBytes = positiveInteger(options.stderrLimitBytes, 64_000, "stderrLimitBytes");
    this.spawnProcess = options.spawn ?? nodeSpawn;
  }

  readonly run: TradingAgentsCnRunner = async (
    taskInput: ResearchTask,
    context: TradingAgentsCnRunnerContext,
  ): Promise<unknown> => {
    const task = validateResearchTask(taskInput);
    const request = createTradingAgentsCnSubprocessRequest(
      task,
      context.timeoutMs,
      this.requestIdGenerator(task),
    );
    const process = this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ?? processEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    return await this.collectResult(process, request, context);
  };

  private async collectResult(
    subprocess: TradingAgentsCnSubprocessProcess,
    request: TradingAgentsCnSubprocessRequest,
    context: TradingAgentsCnRunnerContext,
  ): Promise<unknown> {
    const stdout = createLimitedBuffer(this.stdoutLimitBytes);
    const stderr = createLimitedBuffer(this.stderrLimitBytes);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const stderrSuffix = () => formatStderr(stderr.toString());
    const timeoutError = () => new ResearchProviderError(
      `TradingAgents-CN subprocess timed out after ${context.timeoutMs}ms${stderrSuffix()}`,
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

        context.signal.removeEventListener("abort", onAbort);
        callback();
      };

      const onAbort = () => {
        terminate("abort");
        finish(() => reject(timeoutError()));
      };

      if (context.signal.aborted) {
        onAbort();
        return;
      }

      timeout = setTimeout(() => {
        terminate("timeout");
        finish(() => reject(timeoutError()));
      }, context.timeoutMs);

      context.signal.addEventListener("abort", onAbort, { once: true });

      subprocess.stdout?.on("data", (chunk: Buffer | string) => {
        stdout.append(chunk);
      });
      subprocess.stderr?.on("data", (chunk: Buffer | string) => {
        stderr.append(chunk);
      });
      subprocess.once("error", (error) => {
        finish(() => reject(new ResearchProviderError(
          `TradingAgents-CN subprocess failed to start: ${redactSecretText(error.message)}`,
          { cause: error },
        )));
      });
      subprocess.once("close", (code, signal) => {
        finish(() => {
          if (code !== 0) {
            reject(new ResearchProviderError(
              `TradingAgents-CN subprocess exited with code ${code ?? "null"}`
              + `${signal ? ` and signal ${signal}` : ""}${stderrSuffix()}`,
            ));
            return;
          }

          try {
            resolve(parseTradingAgentsCnSubprocessOutput(stdout.toString(), {
              expectedRequestId: request.requestId,
              stderr: stderr.toString(),
            }));
          } catch (error) {
            reject(toResearchProviderError(error, stderr.toString()));
          }
        });
      });

      if (!subprocess.stdin) {
        terminate("abort");
        finish(() => reject(new ResearchProviderError("TradingAgents-CN subprocess stdin is not writable")));
        return;
      }

      subprocess.stdin.end(`${JSON.stringify(request)}\n`, "utf8");
    });
  }
}

export function createTradingAgentsCnSubprocessRequest(
  taskInput: ResearchTask,
  timeoutMs: number,
  requestId: string,
): TradingAgentsCnSubprocessRequest {
  const task = validateResearchTask(taskInput);

  return {
    protocolVersion: TRADING_AGENTS_CN_RUNNER_PROTOCOL_VERSION,
    requestId,
    task: {
      taskId: task.taskId,
      symbol: task.symbol,
      market: task.market,
      name: task.name,
      tradingDate: task.tradingDate,
      objective: task.objective,
      context: sanitizeRunnerContext(task.context),
      createdAt: task.createdAt,
    },
    options: {
      timeoutMs,
      locale: "zh-CN",
      mode: "paper_research",
      allowNetwork: false,
      allowBroker: false,
      allowOrders: false,
    },
  };
}

export function parseTradingAgentsCnSubprocessOutput(
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
    throw new ResearchProviderError(
      `TradingAgents-CN subprocess returned invalid JSON output${formatStderr(options.stderr)}`,
      { cause: error },
    );
  }

  const record = asRecord(parsed);

  if (!record) {
    throw new ResearchProviderError(
      `TradingAgents-CN subprocess output must be a JSON object${formatStderr(options.stderr)}`,
    );
  }

  const protocolVersion = firstString(record.protocolVersion);

  if (
    protocolVersion
    && protocolVersion !== TRADING_AGENTS_CN_RUNNER_PROTOCOL_VERSION
  ) {
    throw new ResearchProviderError(
      `TradingAgents-CN subprocess returned unsupported protocol ${protocolVersion}`,
    );
  }

  const requestId = firstString(record.requestId);

  if (options.expectedRequestId && requestId && requestId !== options.expectedRequestId) {
    throw new ResearchProviderError(
      `TradingAgents-CN subprocess returned mismatched requestId ${requestId}`,
    );
  }

  const status = firstString(record.status)?.toLowerCase();

  if (status && status !== "ok") {
    const message = firstString(record.error, record.message) ?? `status=${status}`;
    throw new ResearchProviderError(
      `TradingAgents-CN subprocess returned failed status: ${redactSecretText(message)}`,
    );
  }

  if ("report" in record) {
    const report = asRecord(record.report);

    if (!report) {
      throw new ResearchProviderError("TradingAgents-CN subprocess report must be a JSON object");
    }

    return report;
  }

  return record;
}

export function redactTradingAgentsCnStderr(stderr: string): string {
  return redactSecretText(limitText(stderr, 4_000));
}

function extractResultJson(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const prefixedLine = [...lines]
    .reverse()
    .find((line) => line.trimStart().startsWith(TRADING_AGENTS_CN_RESULT_PREFIX));

  if (prefixedLine) {
    return prefixedLine
      .trimStart()
      .slice(TRADING_AGENTS_CN_RESULT_PREFIX.length)
      .trim();
  }

  const trimmed = stdout.trim();

  if (!trimmed) {
    throw new ResearchProviderError("TradingAgents-CN subprocess returned empty stdout");
  }

  return trimmed;
}

function terminateSubprocess(
  subprocess: TradingAgentsCnSubprocessProcess,
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

function sanitizeRunnerContext(value: JsonValue): JsonValue {
  const sanitized = sanitizeJsonValue(value);
  return sanitized === undefined ? {} : sanitized;
}

function sanitizeJsonValue(value: JsonValue): JsonValue | undefined {
  if (typeof value === "string") {
    return redactSecretText(value);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }

  const output: Record<string, JsonValue> = {};

  for (const [key, child] of Object.entries(value)) {
    if (isBlockedContextKey(key)) {
      continue;
    }

    if (isSecretLikeKey(key)) {
      output[key] = "<redacted>";
      continue;
    }

    const sanitized = sanitizeJsonValue(child);

    if (sanitized !== undefined) {
      output[key] = sanitized;
    }
  }

  return output;
}

function isBlockedContextKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return [
    "account",
    "accounts",
    "broker",
    "brokers",
    "credential",
    "credentials",
    "execution",
    "executions",
    "holding",
    "holdings",
    "order",
    "orders",
    "portfolio",
    "portfolios",
    "position",
    "positions",
  ].includes(normalized);
}

function isSecretLikeKey(key: string): boolean {
  return /(api[_-]?key|authorization|cookie|password|passwd|secret|token)/i.test(key);
}

function toResearchProviderError(error: unknown, stderr: string): ResearchProviderError {
  if (error instanceof ResearchProviderError) {
    return error;
  }

  return new ResearchProviderError(
    `TradingAgents-CN subprocess failed: ${String(error)}${formatStderr(stderr)}`,
    { cause: error },
  );
}

function formatStderr(stderr: string | undefined): string {
  if (!stderr?.trim()) {
    return "";
  }

  return `; stderr: ${redactTradingAgentsCnStderr(stderr)}`;
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(
      /(api[_-]?key|authorization|cookie|password|passwd|secret|token)(\s*[:=]\s*)([^\s,;]+)/gi,
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
    throw new ResearchProviderError(`TradingAgentsCnSubprocessRunner ${label} must be positive`);
  }

  return value;
}

function processEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 64) || "id";
}

function limitText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength
    ? trimmed
    : `${trimmed.slice(0, maxLength)}\n<stderr truncated>`;
}
