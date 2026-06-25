import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrainSessionStore } from "../../src/infrastructure/storage/index.js";
import type { AgentMessage } from "../../src/domain/brain/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-session-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("BrainSessionStore", () => {
  it("appends and replays a transcript in order with linked parents", () => {
    const store = new BrainSessionStore({ memoryDir: dir, now: () => new Date("2026-06-24T01:00:00.000Z") });
    const messages: AgentMessage[] = [
      { role: "system", content: "系统" },
      { role: "user", content: "买茅台" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "paper_buy", arguments: "{}" }] },
      { role: "tool", content: "{}", toolCallId: "c1", name: "paper_buy" },
      { role: "assistant", content: "已买入" },
    ];

    store.appendAll("sess-1", messages);
    const entries = store.load("sess-1");

    expect(entries).toHaveLength(5);
    expect(entries[0]!.parentId).toBeNull();
    expect(entries[1]!.parentId).toBe(entries[0]!.id);
    expect(entries[4]!.parentId).toBe(entries[3]!.id);
    expect(store.loadMessages("sess-1").map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("returns an empty transcript for an unknown session", () => {
    const store = new BrainSessionStore({ memoryDir: dir });
    expect(store.load("nope")).toHaveLength(0);
    expect(store.loadMessages("nope")).toHaveLength(0);
  });

  it("persists across store instances (append-only file)", () => {
    const a = new BrainSessionStore({ memoryDir: dir });
    a.append("s", { role: "user", content: "一" });
    const b = new BrainSessionStore({ memoryDir: dir });
    b.append("s", { role: "assistant", content: "二" });
    expect(b.loadMessages("s")).toHaveLength(2);
  });
});
