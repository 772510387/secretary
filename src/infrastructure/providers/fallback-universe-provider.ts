import type { UniverseQuery, UniverseStock } from "../../domain/market/index.js";
import { UniverseProviderError, type UniverseProvider } from "./eastmoney-universe-provider.js";

export interface FallbackUniverseProviderOptions {
  /** Observe each failed attempt (e.g. log "Eastmoney 失败，转新浪"). */
  onAttemptError?: (info: { index: number; error: unknown }) => void;
}

/**
 * Tries an ordered list of universe sources and returns the first that succeeds.
 * The first entry is primary; the rest are fallbacks tried in order when the
 * previous one throws (e.g. Eastmoney rate-limited → Sina). If all throw, it
 * throws a single error summarizing each failure.
 */
export class FallbackUniverseProvider implements UniverseProvider {
  private readonly providers: readonly UniverseProvider[];
  private readonly onAttemptError?: FallbackUniverseProviderOptions["onAttemptError"];

  constructor(providers: readonly UniverseProvider[], options: FallbackUniverseProviderOptions = {}) {
    if (providers.length === 0) {
      throw new UniverseProviderError("FallbackUniverseProvider requires at least one provider");
    }

    this.providers = providers;
    this.onAttemptError = options.onAttemptError;
  }

  async getUniverse(query?: UniverseQuery): Promise<UniverseStock[]> {
    const failures: string[] = [];

    for (let index = 0; index < this.providers.length; index += 1) {
      try {
        return await this.providers[index]!.getUniverse(query);
      } catch (error) {
        this.onAttemptError?.({ index, error });
        failures.push(`#${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new UniverseProviderError(
      `All universe providers failed (${this.providers.length} tried): ${failures.join(" | ")}`,
    );
  }
}
