import { SchedulerError } from "./types.js";

export interface ShutdownHookContext {
  reason: string;
  requestedAt: string;
  signal: AbortSignal;
}

export type ShutdownHook = (context: ShutdownHookContext) => void | Promise<void>;

export interface ShutdownHookResult {
  name: string;
  status: "completed" | "failed";
  error?: string;
}

export interface GracefulShutdownResult {
  reason: string;
  requestedAt: string;
  finishedAt: string;
  hooks: ShutdownHookResult[];
}

export class GracefulShutdown {
  private readonly hooks: Array<{ name: string; hook: ShutdownHook }> = [];
  private readonly controller = new AbortController();
  private shutdownPromise?: Promise<GracefulShutdownResult>;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  register(name: string, hook: ShutdownHook): () => void {
    const normalized = name.trim();

    if (!normalized) {
      throw new SchedulerError("Shutdown hook name must not be empty");
    }

    const entry = { name: normalized, hook };
    this.hooks.push(entry);

    return () => {
      const index = this.hooks.indexOf(entry);

      if (index >= 0) {
        this.hooks.splice(index, 1);
      }
    };
  }

  async shutdown(reason = "manual"): Promise<GracefulShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.runShutdown(reason);
    return this.shutdownPromise;
  }

  private async runShutdown(reason: string): Promise<GracefulShutdownResult> {
    const requestedAt = new Date().toISOString();

    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }

    const results: ShutdownHookResult[] = [];

    for (const entry of [...this.hooks].reverse()) {
      try {
        await entry.hook({
          reason,
          requestedAt,
          signal: this.controller.signal,
        });
        results.push({ name: entry.name, status: "completed" });
      } catch (error) {
        results.push({
          name: entry.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      reason,
      requestedAt,
      finishedAt: new Date().toISOString(),
      hooks: results,
    };
  }
}
