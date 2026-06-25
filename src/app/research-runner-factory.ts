import type { AppConfig } from "../config/schema.js";
import {
  TradingAgentsCnAdapter,
  TradingAgentsCnSubprocessRunner,
} from "../infrastructure/providers/index.js";
import { createMockResearchRunner, type ResearchRunner } from "./run-research-once.js";

export class ResearchRunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchRunnerConfigError";
  }
}

/**
 * Builds the research runner from config.
 *
 * `mock` returns the local deterministic placeholder. `trading_agents_cn` spawns
 * the real multi-agent Python bridge (DashScope Qwen) via the subprocess runner,
 * wrapped in the adapter that normalizes its loose output into a ResearchReport
 * and degrades (rather than throws) on failure/timeout. The model team still only
 * produces a review-required report — no orders, no account writes.
 */
export function createResearchRunner(config: AppConfig): ResearchRunner {
  if (config.research.provider === "mock") {
    return createMockResearchRunner();
  }

  const research = config.research;

  if (!research.command || !research.scriptPath || !research.cwd) {
    throw new ResearchRunnerConfigError(
      "RESEARCH_PROVIDER=trading_agents_cn 需要 RESEARCH_COMMAND（venv python）、RESEARCH_SCRIPT（secretary_bridge.py）和 RESEARCH_CWD（TradingAgents-CN 目录）。",
    );
  }

  const apiKey = config.brain.dashscope.apiKey;

  if (!apiKey) {
    throw new ResearchRunnerConfigError(
      "TradingAgents-CN 深度研究需要 DASHSCOPE_API_KEY（在 .env 配置）。",
    );
  }

  const subprocess = new TradingAgentsCnSubprocessRunner({
    command: research.command,
    args: [research.scriptPath],
    cwd: research.cwd,
    env: {
      ...process.env,
      DASHSCOPE_API_KEY: apiKey,
      ONLINE_TOOLS_ENABLED: "true",
      // chromadb/opentelemetry needs the pure-python protobuf impl here.
      PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION: "python",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      SECRETARY_TA_DEEP_MODEL: research.deepModel,
      SECRETARY_TA_QUICK_MODEL: research.quickModel,
      SECRETARY_TA_ANALYSTS: research.analysts,
    },
    stdoutLimitBytes: 8_000_000,
  });

  return new TradingAgentsCnAdapter({
    runner: subprocess.run,
    timeoutMs: research.timeoutMs,
    fallbackOnError: true,
  });
}
