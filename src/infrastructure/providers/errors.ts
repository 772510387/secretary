export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ProviderError";
    this.cause = options?.cause;
  }
}

export class QuoteProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "QuoteProviderError";
  }
}

export class HistoryProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HistoryProviderError";
  }
}

export class IndexProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IndexProviderError";
  }
}

export class BrainProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrainProviderError";
  }
}

export class ResearchProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResearchProviderError";
  }
}
