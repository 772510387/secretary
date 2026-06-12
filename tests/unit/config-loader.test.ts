import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigLoadError,
  DEFAULT_DASHSCOPE_BASE_URL,
  getConfiguredSecrets,
  isLiveTradingEnabled,
  loadConfig,
  redactConfig,
} from "../../src/config/index.js";

const tempRoots: string[] = [];

describe("ConfigLoader", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("loads default config when .env is missing", () => {
    const projectRoot = createProject();

    const config = loadConfig({ projectRoot, includeProcessEnv: false });

    expect(config.runtime.timezone).toBe("Asia/Shanghai");
    expect(config.runtime.liveTrading).toBe(false);
    expect(config.brain.provider).toBe("mock");
    expect(config.broker.provider).toBe("paper");
    expect(config.brain.dashscope.baseUrl).toBe(DEFAULT_DASHSCOPE_BASE_URL);
    expect(config.storage.dataDir).toBe(path.resolve(projectRoot, "data"));
    expect(config.storage.memoryDir).toBe(path.resolve(projectRoot, "memory"));
    expect(isLiveTradingEnabled(config)).toBe(false);
  });

  it("overrides config with .env and keeps secrets redactable", () => {
    const projectRoot = createProject(
      defaultConfig(),
      [
        "BRAIN_PROVIDER=dashscope",
        "DASHSCOPE_API_KEY=\"dash#scope-secret\"",
        "DASHSCOPE_MODEL=qwen-plus",
        `DASHSCOPE_BASE_URL=${DEFAULT_DASHSCOPE_BASE_URL}`,
        "LIVE_TRADING=true",
        "BROKER_PROVIDER=paper",
        "SECRETARY_DATA_DIR=./custom-data",
      ].join("\n"),
    );

    const config = loadConfig({ projectRoot, includeProcessEnv: false });

    expect(config.brain.provider).toBe("dashscope");
    expect(config.brain.dashscope.apiKey).toBe("dash#scope-secret");
    expect(config.brain.dashscope.model).toBe("qwen-plus");
    expect(config.storage.dataDir).toBe(path.resolve(projectRoot, "custom-data"));
    expect(getConfiguredSecrets(config).dashscopeApiKey).toBe(true);
    expect(redactConfig(config).brain.dashscope.apiKey).toBe("[redacted]");
    expect(isLiveTradingEnabled(config)).toBe(false);
  });

  it("treats explicit env values as higher priority than .env", () => {
    const projectRoot = createProject(defaultConfig(), "BRAIN_PROVIDER=gemini");

    const config = loadConfig({
      projectRoot,
      includeProcessEnv: false,
      env: {
        BRAIN_PROVIDER: "openai",
        OPENAI_MODEL: "gpt-test",
      },
    });

    expect(config.brain.provider).toBe("openai");
    expect(config.brain.openai.model).toBe("gpt-test");
  });

  it("requires live mode and a non-paper broker before live trading is enabled", () => {
    const projectRoot = createProject(
      defaultConfig(),
      ["LIVE_TRADING=true", "TRADING_MODE=live", "BROKER_PROVIDER=qmt"].join("\n"),
    );

    const config = loadConfig({ projectRoot, includeProcessEnv: false });

    expect(isLiveTradingEnabled(config)).toBe(true);
  });

  it("throws a clear error for invalid env booleans", () => {
    const projectRoot = createProject(defaultConfig(), "LIVE_TRADING=maybe");

    expect(() => loadConfig({ projectRoot, includeProcessEnv: false })).toThrow(
      /Invalid boolean env LIVE_TRADING/,
    );
  });

  it("throws a clear error for invalid config values", () => {
    const config = defaultConfig();
    config.market.sentinelIntervalMs = 500;
    const projectRoot = createProject(config);

    expect(() => loadConfig({ projectRoot, includeProcessEnv: false })).toThrow(
      ConfigLoadError,
    );
    expect(() => loadConfig({ projectRoot, includeProcessEnv: false })).toThrow(
      /market.sentinelIntervalMs/,
    );
  });
});

function createProject(config = defaultConfig(), envContent?: string): string {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "secretary-config-"));
  tempRoots.push(projectRoot);

  mkdirSync(path.join(projectRoot, "config"), { recursive: true });
  writeFileSync(
    path.join(projectRoot, "config", "default.example.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  if (envContent !== undefined) {
    writeFileSync(path.join(projectRoot, ".env"), `${envContent}\n`, "utf8");
  }

  return projectRoot;
}

function defaultConfig() {
  return {
    runtime: {
      nodeEnv: "development",
      timezone: "Asia/Shanghai",
      liveTrading: false,
    },
    storage: {
      dataDir: "./data",
      memoryDir: "./memory",
    },
    market: {
      provider: "tencent",
      sentinelIntervalMs: 3000,
      quoteTimeoutMs: 5000,
    },
    trading: {
      mode: "paper",
      initialCash: 20000,
      mainBoardOnly: true,
      lotSize: 100,
      t1Enabled: true,
    },
    broker: {
      provider: "paper",
    },
    risk: {
      maxSinglePositionRatio: 0.4,
      hardStopLossRatio: 0.08,
      dailyLossLimitRatio: 0.03,
      maxDailyOrderCount: 20,
    },
    brain: {
      provider: "mock",
      temperature: 0.2,
      structuredOutput: true,
      openai: {},
      gemini: {},
      dashscope: {
        baseUrl: DEFAULT_DASHSCOPE_BASE_URL,
      },
    },
    notification: {
      defaultCooldownSeconds: 600,
      criticalCooldownSeconds: 60,
    },
  };
}

