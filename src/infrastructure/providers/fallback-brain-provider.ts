import type {
  BrainGenerateOptions,
  BrainInput,
  BrainOutput,
  BrainProvider,
} from "../../domain/brain/index.js";
import { BrainProviderError } from "./errors.js";

export interface FallbackBrainProviderOptions {
  /** Optional hook to observe each failed attempt (e.g. logging/metrics). */
  onAttemptError?: (info: {
    providerName: BrainProvider["providerName"];
    index: number;
    error: unknown;
  }) => void;
}

/**
 * Tries an ordered list of brain providers and returns the first successful
 * BrainOutput. The first entry is the primary; the rest are fallbacks tried in
 * order when the previous one throws. If every provider fails, it throws a
 * single BrainProviderError summarizing each failure.
 *
 * This is how "Gemini primary, DashScope fallback" is expressed: each child
 * still does its own local validation, so a degraded or invalid response from
 * the primary triggers the fallback instead of a bad report.
 */
export class FallbackBrainProvider implements BrainProvider {
  readonly providerName: BrainProvider["providerName"];
  private readonly providers: readonly BrainProvider[];
  private readonly onAttemptError?: FallbackBrainProviderOptions["onAttemptError"];

  constructor(providers: readonly BrainProvider[], options: FallbackBrainProviderOptions = {}) {
    if (providers.length === 0) {
      throw new BrainProviderError("FallbackBrainProvider requires at least one provider");
    }

    this.providers = providers;
    // Cosmetic: report the primary's name. The actual successful provider is
    // always reflected truthfully in the returned output.provider.
    this.providerName = providers[0]!.providerName;
    this.onAttemptError = options.onAttemptError;
  }

  async generate(input: BrainInput, options: BrainGenerateOptions = {}): Promise<BrainOutput> {
    const failures: string[] = [];

    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index]!;

      try {
        return await provider.generate(input, options);
      } catch (error) {
        this.onAttemptError?.({ providerName: provider.providerName, index, error });
        failures.push(
          `${provider.providerName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new BrainProviderError(
      `All brain providers failed (${this.providers.length} tried): ${failures.join(" | ")}`,
    );
  }
}
