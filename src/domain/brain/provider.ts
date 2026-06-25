import { z } from "zod";
import type { JsonValue } from "../shared/index.js";
import type { BrainInput, BrainOutput, BrainProviderName } from "./schemas.js";

/** Heartbeat emitted while a streaming response accumulates. */
export interface BrainStreamProgress {
  /** Characters of model content received so far. */
  chars: number;
  /** Milliseconds since the request started. */
  elapsedMs: number;
}

export interface BrainGenerateOptions {
  structuredOutputSchema?: z.ZodType<unknown>;
  /** External cancellation (e.g. a turn-level AbortController). */
  signal?: AbortSignal;
  /**
   * Liveness heartbeat for the streaming path (called as content accumulates). Lets a
   * caller log/show progress without changing the returned contract. Ignored by the
   * non-streaming path.
   */
  onProgress?: (progress: BrainStreamProgress) => void;
  /** Override the provider's idle (keepalive) timeout for the streaming path, in ms. */
  idleTimeoutMs?: number;
}

export interface BrainProvider {
  readonly providerName: BrainProviderName;
  generate(input: BrainInput, options?: BrainGenerateOptions): Promise<BrainOutput>;
  /**
   * Optional streaming variant. Same returned contract as {@link generate}, but the
   * request is streamed (SSE) so a long answer is bounded by an IDLE timeout rather
   * than a single total timeout — a steadily-producing model completes regardless of
   * length, while a stalled one is still cut off. Callers should prefer this when
   * present via {@link generateBrainOutput}.
   */
  generateStream?(input: BrainInput, options?: BrainGenerateOptions): Promise<BrainOutput>;
}

/**
 * Runs a brain request preferring the provider's streaming path (idle-timeout +
 * progress) when it exposes one, falling back to the plain blocking call otherwise.
 * This is the seam the user-facing chat/analysis path uses so a long but live answer
 * no longer dies at the total timeout.
 */
export function generateBrainOutput(
  provider: BrainProvider,
  input: BrainInput,
  options?: BrainGenerateOptions,
): Promise<BrainOutput> {
  return provider.generateStream
    ? provider.generateStream(input, options)
    : provider.generate(input, options);
}

export type BrainStructuredOutput = JsonValue;
