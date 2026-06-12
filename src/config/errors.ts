import { ZodError } from "zod";

export class ConfigLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ConfigLoadError";
    this.cause = options?.cause;
  }
}

export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

