export class BrainValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "BrainValidationError";
    this.cause = options?.cause;
  }
}
