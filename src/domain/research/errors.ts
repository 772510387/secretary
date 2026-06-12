export class ResearchValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ResearchValidationError";
    this.cause = options?.cause;
  }
}
