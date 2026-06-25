import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rememberModelNote, searchModelMemory } from "../../src/app/index.js";

let memoryDir: string;
let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "model-memory-"));
  memoryDir = path.join(root, "memory");
  mkdirSync(memoryDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedLongTerm(relPath: string, content: string): void {
  const full = path.join(memoryDir, "long_term", relPath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("searchModelMemory (MEM-07 read)", () => {
  it("finds a relevant lesson by keyword and caps results", () => {
    seedLongTerm("2026-06/2026-06-20.md", "# 长期记忆\n\n- 大盘跳水时优先买银行股护盘，剑盾双修。\n");
    seedLongTerm("2026-06/2026-06-21.md", "# 长期记忆\n\n- 不要在尾盘缩量时追高。\n");

    const found = searchModelMemory({ memoryDir, query: "大盘跳水 护盘" });
    expect(found.ok).toBe(true);
    expect(found.count).toBeGreaterThanOrEqual(1);
    expect(found.hits[0]!.snippet).toContain("银行股");
  });

  it("returns empty (not throw) when memory dir has nothing", () => {
    const found = searchModelMemory({ memoryDir, query: "不存在的关键词xyz" });
    expect(found.ok).toBe(true);
    expect(found.count).toBe(0);
  });
});

describe("rememberModelNote (MEM-05 guarded write)", () => {
  it("appends to a FIXED long_term path and never overwrites", () => {
    const first = rememberModelNote({ memoryDir, note: "银行股护盘有效", kind: "lesson", now: "2026-06-24T02:00:00.000Z" });
    expect(first.ok).toBe(true);
    expect(first.path).toContain(path.join("long_term", "2026-06", "model-notes.md"));

    const second = rememberModelNote({ memoryDir, note: "尾盘别追高", kind: "mistake", now: "2026-06-24T03:00:00.000Z" });
    expect(second.ok).toBe(true);
    expect(second.path).toBe(first.path);

    const body = readFileSync(first.path!, "utf8");
    expect(body).toContain("银行股护盘有效"); // first note kept
    expect(body).toContain("尾盘别追高"); // second appended, not clobbered
  });

  it("redacts secret-shaped content and rejects an empty note", () => {
    const written = rememberModelNote({
      memoryDir,
      note: "api_key=sk-abcdef123456 记得轮换",
      now: "2026-06-24T02:00:00.000Z",
    });
    expect(written.ok).toBe(true);
    const body = readFileSync(written.path!, "utf8");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("sk-abcdef123456");

    const empty = rememberModelNote({ memoryDir, note: "   ", now: "2026-06-24T02:00:00.000Z" });
    expect(empty.ok).toBe(false);
  });

  it("a written note is then findable via search (read+write round-trip)", () => {
    rememberModelNote({ memoryDir, note: "高位炸板要减仓", kind: "lesson", now: "2026-06-24T02:00:00.000Z" });
    const found = searchModelMemory({ memoryDir, query: "炸板 减仓" });
    expect(found.count).toBeGreaterThanOrEqual(1);
  });
});
