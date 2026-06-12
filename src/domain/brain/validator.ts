import { z } from "zod";
import { BrainValidationError } from "./errors.js";
import {
  brainInputSchema,
  brainOutputSchema,
  type BrainInput,
  type BrainOutput,
} from "./schemas.js";

export type StructuredOutputValidator<T> = (value: unknown) => T;

export function validateBrainInput(input: unknown): BrainInput {
  return parseOrThrow(() => brainInputSchema.parse(input), "Invalid brain input");
}

export function validateBrainOutput(
  output: unknown,
  structuredOutputSchema?: z.ZodType<unknown>,
): BrainOutput {
  const parsed = parseOrThrow(() => brainOutputSchema.parse(output), "Invalid brain output");

  if (structuredOutputSchema) {
    parseOrThrow(
      () => structuredOutputSchema.parse(parsed.structured),
      "Invalid brain structured output",
    );
  }

  return parsed;
}

export function createStructuredOutputValidator<T>(
  schema: z.ZodType<T>,
): StructuredOutputValidator<T> {
  return (value: unknown): T =>
    parseOrThrow(() => schema.parse(value), "Invalid brain structured output");
}

function parseOrThrow<T>(parse: () => T, message: string): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof BrainValidationError) {
      throw error;
    }

    throw new BrainValidationError(formatValidationMessage(message, error), {
      cause: error,
    });
  }
}

function formatValidationMessage(message: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];

    if (issue) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${message}: ${path} ${issue.message}`;
    }
  }

  return message;
}
