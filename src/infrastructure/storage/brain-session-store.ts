import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "../../domain/brain/index.js";

/**
 * B2 — append-only brain session persistence (borrowed from openclaw's JSONL session
 * storage). Every transcript message is one JSONL line carrying a stable id and a
 * parentId pointer, so a session is a tree that can branch (re-ask from a past point)
 * yet replays linearly by default. Pure deterministic storage — no model, no network.
 *
 * Reconstructing context for a continued turn = `loadMessages(sessionId)` (optionally
 * fed through `compactSession` to bound the window).
 */
export interface BrainSessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface BrainSessionPaths {
  root: string;
  fileFor(sessionId: string): string;
}

export function createBrainSessionPaths(memoryDir: string): BrainSessionPaths {
  const root = join(memoryDir, "brain", "sessions");
  return {
    root,
    fileFor(sessionId: string): string {
      return join(root, `${sanitizeSessionId(sessionId)}.jsonl`);
    },
  };
}

export interface BrainSessionStoreOptions {
  memoryDir: string;
  now?: () => Date;
}

export class BrainSessionStore {
  private readonly paths: BrainSessionPaths;
  private readonly now: () => Date;

  constructor(options: BrainSessionStoreOptions) {
    this.paths = createBrainSessionPaths(options.memoryDir);
    this.now = options.now ?? (() => new Date());
  }

  /** Appends one message; parentId links to the current leaf (linear by default). */
  append(sessionId: string, message: AgentMessage): BrainSessionEntry {
    const existing = this.load(sessionId);
    const parentId = existing.length > 0 ? existing[existing.length - 1]!.id : null;
    const entry: BrainSessionEntry = {
      id: `${sanitizeSessionId(sessionId)}-${existing.length}`,
      parentId,
      timestamp: this.isoNow(),
      message,
    };
    this.writeLine(sessionId, entry);
    return entry;
  }

  /** Appends a batch of messages in order. */
  appendAll(sessionId: string, messages: AgentMessage[]): BrainSessionEntry[] {
    return messages.map((message) => this.append(sessionId, message));
  }

  load(sessionId: string): BrainSessionEntry[] {
    const file = this.paths.fileFor(sessionId);
    if (!existsSync(file)) {
      return [];
    }
    const raw = readFileSync(file, "utf8");
    const entries: BrainSessionEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed) as BrainSessionEntry);
      } catch {
        // Skip a corrupt/partial line rather than failing the whole load.
      }
    }
    return entries;
  }

  loadMessages(sessionId: string): AgentMessage[] {
    return this.load(sessionId).map((entry) => entry.message);
  }

  private writeLine(sessionId: string, entry: BrainSessionEntry): void {
    const file = this.paths.fileFor(sessionId);
    mkdirSync(this.paths.root, { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  }

  private isoNow(): string {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error("BrainSessionStore now() returned an invalid Date");
    }
    return value.toISOString();
  }
}

function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "session";
}
