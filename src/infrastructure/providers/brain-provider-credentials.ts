import type { BrainProviderName } from "../../domain/brain/index.js";
import { BrainProviderError } from "./errors.js";

export function requireBrainProviderApiKey(
  providerName: Exclude<BrainProviderName, "mock">,
  apiKey: string | undefined,
): string {
  const normalized = apiKey?.trim();

  if (!normalized) {
    throw new BrainProviderError(
      `Brain provider ${providerName} requires an API key; use mock provider or configure the provider secret.`,
    );
  }

  return normalized;
}
