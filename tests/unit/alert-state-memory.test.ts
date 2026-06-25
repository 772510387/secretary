import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AlertStateStore } from "../../src/infrastructure/storage/index.js";

const tmpRoots: string[] = [];
function tmpDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "alert-state-"));
  tmpRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("AlertStateStore (alert_state.json cooldown persistence)", () => {
  it("returns {} when no file exists yet", () => {
    const store = new AlertStateStore({ memoryDir: tmpDir() });
    expect(store.readCooldownState()).toEqual({});
  });

  it("round-trips the cooldown map across instances (survives a restart)", () => {
    const memoryDir = tmpDir();
    const state = {
      "price_drop:SZSE:000636": "2026-06-23T01:30:00.000Z",
      "position_stop_loss:SSE:601187": "2026-06-23T02:00:00.000Z",
    };
    new AlertStateStore({ memoryDir }).writeCooldownState(state);

    // A fresh instance (like a daemon restart) reads the persisted cooldowns back.
    expect(new AlertStateStore({ memoryDir }).readCooldownState()).toEqual(state);
  });

  it("overwrites prior state on a subsequent write", () => {
    const memoryDir = tmpDir();
    const store = new AlertStateStore({ memoryDir });
    store.writeCooldownState({ a: "2026-06-23T01:00:00.000Z" });
    store.writeCooldownState({ b: "2026-06-23T02:00:00.000Z" });
    expect(store.readCooldownState()).toEqual({ b: "2026-06-23T02:00:00.000Z" });
  });
});
