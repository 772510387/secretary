import { ZodError } from "zod";

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "StorageError";
    this.cause = options?.cause;
  }
}

export class JsonStoreValidationError extends StorageError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "JsonStoreValidationError";
  }
}

export function formatStorageZodError(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

