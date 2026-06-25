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
  /** True for transient failures (429/5xx/empty response) worth a bounded retry. */
  readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options);
    this.name = "BrainProviderError";
    this.retryable = options?.retryable ?? false;
  }
}

export class ResearchProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResearchProviderError";
  }
}

export class SearchProviderError extends ProviderError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SearchProviderError";
  }
}
