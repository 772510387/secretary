import type { AppConfig } from "../../config/schema.js";
import type { BrainProvider, BrainProviderName } from "../../domain/brain/index.js";
import { BrainProviderError } from "./errors.js";
import { requireBrainProviderApiKey } from "./brain-provider-credentials.js";
import { MockBrainProvider } from "./mock-brain-provider.js";
import { DashScopeQwenProvider } from "./dashscope-qwen-provider.js";
import { OpenAIProvider } from "./openai-provider.js";
import { GeminiProvider } from "./gemini-provider.js";
import { FallbackBrainProvider } from "./fallback-brain-provider.js";

export type BrainConfig = AppConfig["brain"];

export interface CreateBrainProviderOptions {
  /** Injected clock, mainly for deterministic tests. */
  now?: () => Date;
  /**
   * Validate that each selected real provider has an API key up front (default true).
   * Set false to construct providers lazily and defer the key check to generate().
   */
  requireApiKey?: boolean;
}

/**
 * Maps the resolved `config.brain` slice to a concrete BrainProvider.
 *
 * If `config.brain.fallbackProvider` is set (and differs from the primary), the
 * result is a FallbackBrainProvider that tries the primary first and falls back
 * to the secondary on failure — e.g. Gemini primary, DashScope fallback.
 *
 * The factory only constructs providers; it never calls the network on its own.
 */
export function createBrainProvider(
  config: BrainConfig,
  options: CreateBrainProviderOptions = {},
): BrainProvider {
  const primary = buildSingleProvider(config.provider, config, options);

  if (config.fallbackProvider === undefined || config.fallbackProvider === config.provider) {
    return primary;
  }

  const fallback = buildSingleProvider(config.fallbackProvider, config, options);
  return new FallbackBrainProvider([primary, fallback]);
}

/** Builds exactly one provider for the given name using the shared brain config. */
export function buildSingleProvider(
  providerName: BrainProviderName,
  config: BrainConfig,
  options: CreateBrainProviderOptions = {},
): BrainProvider {
  const requireKey = options.requireApiKey ?? true;

  switch (providerName) {
    case "mock":
      return new MockBrainProvider({ now: options.now });

    case "dashscope": {
      const apiKey = config.dashscope.apiKey;

      if (requireKey) {
        requireBrainProviderApiKey("dashscope", apiKey);
      }

      return new DashScopeQwenProvider({
        apiKey,
        endpoint: toChatCompletionsEndpoint(config.dashscope.baseUrl),
        model: config.dashscope.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        streaming: config.streaming,
        idleTimeoutMs: config.idleTimeoutMs,
        maxTokens: config.maxTokens,
        now: options.now,
      });
    }

    case "openai": {
      const apiKey = config.openai.apiKey;

      if (requireKey) {
        requireBrainProviderApiKey("openai", apiKey);
      }

      return new OpenAIProvider({
        apiKey,
        model: config.openai.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        now: options.now,
      });
    }

    case "gemini": {
      const apiKey = config.gemini.apiKey;

      if (requireKey) {
        requireBrainProviderApiKey("gemini", apiKey);
      }

      return new GeminiProvider({
        apiKey,
        model: config.gemini.model,
        temperature: config.temperature,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        now: options.now,
      });
    }

    default: {
      const exhaustive: never = providerName;
      throw new BrainProviderError(`Unknown brain provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * Normalizes an OpenAI-compatible base URL (e.g. the DashScope compatible-mode
 * `.../v1`) into the full chat-completions endpoint the providers expect.
 */
export function toChatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}
