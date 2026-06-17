import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  BrainProviderError,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import type { BrainInput } from "../../src/domain/brain/index.js";

const NETWORK_FLAG = "BRAIN_NETWORK_SMOKE";

/**
 * One-shot brain provider smoke check.
 *
 * Builds the BrainProvider configured by BRAIN_PROVIDER and sends a single
 * harmless `user_query` prompt, then prints the structured result. This is the
 * only runnable path that actually calls a real LLM provider, so it stays
 * behind an explicit opt-in: real providers require BRAIN_NETWORK_SMOKE=1.
 * The mock provider runs offline without the flag.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.brain.provider;
  const networkAllowed = process.env[NETWORK_FLAG] === "1";

  if (providerName !== "mock" && !networkAllowed) {
    console.error(
      [
        `Refusing to run a real ${providerName} smoke call without explicit opt-in.`,
        `Set ${NETWORK_FLAG}=1 to allow the outbound request, or BRAIN_PROVIDER=mock to run offline.`,
      ].join(" "),
    );
    process.exit(2);
    return;
  }

  const provider = createBrainProvider(config.brain);
  const input: BrainInput = {
    requestId: `brain-smoke-${Date.now()}`,
    taskType: "user_query",
    prompt:
      "Reply with a one-sentence confirmation that you are reachable. " +
      "Do not propose trades, do not place orders, do not write memory.",
    context: { purpose: "brain-provider-smoke" },
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      toolPermissions: [],
    },
  };

  const output = await provider.generate(input);

  console.log(
    JSON.stringify(
      {
        status: "ok",
        mode: "brain-smoke",
        provider: output.provider,
        model: output.model,
        networkAllowed,
        confidence: output.confidence,
        summary: output.summary,
        proposalCount: output.proposals.length,
        liveTrading: false,
        brokerConnected: false,
      },
      null,
      2,
    ),
  );
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigLoadError || error instanceof BrainProviderError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
