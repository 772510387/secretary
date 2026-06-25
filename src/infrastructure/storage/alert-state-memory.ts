import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AtomicFileWriter } from "./atomic-file-writer.js";

/**
 * Persists the sentinel/patrol cooldown state to `memory/alert_state.json`.
 *
 * Without this the 10-minute "is this alert still cooling down?" state lived only in a
 * daemon closure, so a restart (or the 3s sentinel vs the 10-min patrol) would re-spam the
 * same alert. This file is the shared, on-disk cooldown ledger both the 3-second sentinel
 * and the 10-minute chained-silence patrol read at start and write after each tick.
 */
export const alertStateSchema = z
  .object({
    cooldownState: z.record(z.string()).default({}),
    updatedAt: z.string().optional(),
  })
  .strict();

export type AlertState = z.infer<typeof alertStateSchema>;

export class AlertStateStore {
  private readonly filePath: string;
  private readonly writer: AtomicFileWriter;
  private readonly now: () => Date;

  constructor(options: { memoryDir: string; writer?: AtomicFileWriter; now?: () => Date }) {
    this.filePath = path.join(path.resolve(options.memoryDir), "alert_state.json");
    this.writer = options.writer ?? new AtomicFileWriter();
    this.now = options.now ?? (() => new Date());
  }

  /** Reads the persisted cooldown map (best-effort: a missing/corrupt file yields {}). */
  readCooldownState(): Record<string, string> {
    try {
      const parsed = alertStateSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      return { ...parsed.cooldownState };
    } catch {
      return {};
    }
  }

  /** Persists the cooldown map atomically (best-effort: never throws into the daemon loop). */
  writeCooldownState(cooldownState: Record<string, string>): void {
    try {
      const state: AlertState = { cooldownState, updatedAt: this.now().toISOString() };
      this.writer.write(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // A persistence hiccup must never crash the sentinel; in-memory state still holds.
    }
  }
}
