import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import {
  mergeEnvMaps,
  parseDotEnv,
  readBooleanEnv,
  readNumberEnv,
  readStringEnv,
  type EnvMap,
} from "./env.js";
import { ConfigLoadError, formatZodError } from "./errors.js";
import { appConfigSchema, type AppConfig } from "./schema.js";

export type DeepPartial<T> = T extends Array<infer U>
  ? Array<DeepPartial<U>>
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface LoadConfigOptions {
  projectRoot?: string;
  configPath?: string;
  envPath?: string | null;
  env?: EnvMap;
  includeProcessEnv?: boolean;
  overrides?: DeepPartial<AppConfig>;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const configPath = path.resolve(
    projectRoot,
    options.configPath ?? "config/default.example.json",
  );
  const envPath =
    options.envPath === null
      ? null
      : path.resolve(projectRoot, options.envPath ?? ".env");

  const fileConfig = normalizeConfigShape(readJsonConfig(configPath));
  const dotEnv = envPath && existsSync(envPath) ? parseDotEnv(readTextFile(envPath)) : {};
  const mergedEnv = mergeEnvMaps(
    dotEnv,
    options.includeProcessEnv === false ? {} : process.env,
    options.env ?? {},
  );
  const envOverrides = buildEnvOverrides(mergedEnv);
  const unresolvedConfig = deepMerge(fileConfig, envOverrides, options.overrides ?? {});

  try {
    const parsed = appConfigSchema.parse(unresolvedConfig);
    return resolveStoragePaths(parsed, projectRoot);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigLoadError(`Invalid application config: ${formatZodError(error)}`, {
        cause: error,
      });
    }

    throw error;
  }
}

export function isLiveTradingEnabled(config: AppConfig): boolean {
  return (
    config.runtime.liveTrading === true &&
    config.trading.mode === "live" &&
    !["paper", "readonly"].includes(config.broker.provider)
  );
}

export function redactConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    market: {
      ...config.market,
      tushareToken: redactSecret(config.market.tushareToken),
    },
    brain: {
      ...config.brain,
      openai: {
        ...config.brain.openai,
        apiKey: redactSecret(config.brain.openai.apiKey),
      },
      gemini: {
        ...config.brain.gemini,
        apiKey: redactSecret(config.brain.gemini.apiKey),
      },
      dashscope: {
        ...config.brain.dashscope,
        apiKey: redactSecret(config.brain.dashscope.apiKey),
      },
    },
    broker: {
      ...config.broker,
      accountId: redactSecret(config.broker.accountId),
    },
  };
}

export function getConfiguredSecrets(config: AppConfig): Record<string, boolean> {
  return {
    openaiApiKey: Boolean(config.brain.openai.apiKey),
    geminiApiKey: Boolean(config.brain.gemini.apiKey),
    dashscopeApiKey: Boolean(config.brain.dashscope.apiKey),
    tushareToken: Boolean(config.market.tushareToken),
    brokerAccountId: Boolean(config.broker.accountId),
  };
}

function readJsonConfig(configPath: string): unknown {
  if (!existsSync(configPath)) {
    throw new ConfigLoadError(`Config file not found: ${configPath}`);
  }

  try {
    return JSON.parse(readTextFile(configPath)) as unknown;
  } catch (error) {
    throw new ConfigLoadError(`Failed to parse config JSON: ${configPath}`, { cause: error });
  }
}

function readTextFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    throw new ConfigLoadError(`Failed to read file: ${filePath}`, { cause: error });
  }
}

function buildEnvOverrides(env: EnvMap): DeepPartial<AppConfig> {
  return compactObject({
    runtime: {
      nodeEnv: readStringEnv(env, "NODE_ENV"),
      timezone: readStringEnv(env, "TIMEZONE"),
      liveTrading: readBooleanEnv(env, "LIVE_TRADING"),
    },
    storage: {
      dataDir: readStringEnv(env, "SECRETARY_DATA_DIR"),
      memoryDir: readStringEnv(env, "SECRETARY_MEMORY_DIR"),
    },
    market: {
      provider: readStringEnv(env, "MARKET_PROVIDER"),
      sentinelIntervalMs: readNumberEnv(env, "SENTINEL_INTERVAL_MS"),
      quoteTimeoutMs: readNumberEnv(env, "QUOTE_TIMEOUT_MS"),
      tushareToken: readStringEnv(env, "TUSHARE_TOKEN"),
    },
    trading: {
      mode: readStringEnv(env, "TRADING_MODE"),
      initialCash: readNumberEnv(env, "INITIAL_CASH"),
      mainBoardOnly: readBooleanEnv(env, "MAIN_BOARD_ONLY"),
      lotSize: readNumberEnv(env, "LOT_SIZE"),
      t1Enabled: readBooleanEnv(env, "T1_ENABLED"),
    },
    broker: {
      provider: readStringEnv(env, "BROKER_PROVIDER"),
      accountId: readStringEnv(env, "BROKER_ACCOUNT_ID"),
    },
    risk: {
      maxSinglePositionRatio: readNumberEnv(env, "MAX_SINGLE_POSITION_RATIO"),
      hardStopLossRatio: readNumberEnv(env, "HARD_STOP_LOSS_RATIO"),
      dailyLossLimitRatio: readNumberEnv(env, "DAILY_LOSS_LIMIT_RATIO"),
      maxDailyOrderCount: readNumberEnv(env, "MAX_DAILY_ORDER_COUNT"),
    },
    brain: {
      provider: readStringEnv(env, "BRAIN_PROVIDER"),
      temperature: readNumberEnv(env, "BRAIN_TEMPERATURE"),
      structuredOutput: readBooleanEnv(env, "BRAIN_STRUCTURED_OUTPUT"),
      openai: {
        apiKey: readStringEnv(env, "OPENAI_API_KEY"),
        model: readStringEnv(env, "OPENAI_MODEL"),
      },
      gemini: {
        apiKey: readStringEnv(env, "GEMINI_API_KEY"),
        model: readStringEnv(env, "GEMINI_MODEL"),
      },
      dashscope: {
        apiKey: readStringEnv(env, "DASHSCOPE_API_KEY"),
        baseUrl: readStringEnv(env, "DASHSCOPE_BASE_URL"),
        model: readStringEnv(env, "DASHSCOPE_MODEL"),
      },
    },
    notification: {
      defaultCooldownSeconds: readNumberEnv(env, "DEFAULT_COOLDOWN_SECONDS"),
      criticalCooldownSeconds: readNumberEnv(env, "CRITICAL_COOLDOWN_SECONDS"),
    },
  }) as DeepPartial<AppConfig>;
}

function normalizeConfigShape(config: unknown): unknown {
  if (!isPlainObject(config)) {
    return config;
  }

  const normalized: Record<string, unknown> = { ...config };

  if (typeof normalized.timezone === "string") {
    const runtime = isPlainObject(normalized.runtime) ? normalized.runtime : {};
    normalized.runtime = {
      ...runtime,
      timezone: runtime.timezone ?? normalized.timezone,
    };
    delete normalized.timezone;
  }

  return normalized;
}

function resolveStoragePaths(config: AppConfig, projectRoot: string): AppConfig {
  return {
    ...config,
    storage: {
      dataDir: resolveMaybeRelative(projectRoot, config.storage.dataDir),
      memoryDir: resolveMaybeRelative(projectRoot, config.storage.memoryDir),
    },
  };
}

function resolveMaybeRelative(projectRoot: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(projectRoot, value);
}

function redactSecret(value: string | undefined): string | undefined {
  return value ? "[redacted]" : undefined;
}

function deepMerge<T>(...values: Array<DeepPartial<T> | unknown>): T {
  const result: Record<string, unknown> = {};

  for (const value of values) {
    if (!isPlainObject(value)) {
      continue;
    }

    for (const [key, nextValue] of Object.entries(value)) {
      if (nextValue === undefined) {
        continue;
      }

      const previousValue = result[key];
      result[key] =
        isPlainObject(previousValue) && isPlainObject(nextValue)
          ? deepMerge(previousValue, nextValue)
          : nextValue;
    }
  }

  return result as T;
}

function compactObject(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};

  for (const [key, nextValue] of Object.entries(value)) {
    if (nextValue === undefined) {
      continue;
    }

    const compacted = compactObject(nextValue);

    if (isPlainObject(compacted) && Object.keys(compacted).length === 0) {
      continue;
    }

    result[key] = compacted;
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

