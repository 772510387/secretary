import {
  ConfigLoadError,
  getConfiguredSecrets,
  isLiveTradingEnabled,
  loadConfig,
} from "../../src/config/index.js";

try {
  const config = loadConfig();
  const summary = {
    status: "ok",
    nodeEnv: config.runtime.nodeEnv,
    timezone: config.runtime.timezone,
    liveTradingEnabled: isLiveTradingEnabled(config),
    brainProvider: config.brain.provider,
    marketProvider: config.market.provider,
    brokerProvider: config.broker.provider,
    dataDir: config.storage.dataDir,
    memoryDir: config.storage.memoryDir,
    secrets: getConfiguredSecrets(config),
  };

  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (error instanceof ConfigLoadError) {
    console.error(error.message);
    process.exit(1);
  }

  throw error;
}

