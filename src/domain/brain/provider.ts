import { z } from "zod";
import type { JsonValue } from "../shared/index.js";
import type { BrainInput, BrainOutput, BrainProviderName } from "./schemas.js";

export interface BrainGenerateOptions {
  structuredOutputSchema?: z.ZodType<unknown>;
}

export interface BrainProvider {
  readonly providerName: BrainProviderName;
  generate(input: BrainInput, options?: BrainGenerateOptions): Promise<BrainOutput>;
}

export type BrainStructuredOutput = JsonValue;
