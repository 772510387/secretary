import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureMemoryLayout } from "../../src/app/ensure-memory-layout.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ensure-layout-"));
  tempDirs.push(dir);
  return dir;
}

const EXPECTED_DIRS = [
  "rules",
  "long_term",
  "daily_logs",
  "reviews",
  "history",
  "logs",
  path.join("portfolio", "snapshots"),
  path.join("market", "watchlists"),
  path.join("market", "cache"),
  "plans",
  "proposals",
  "reports",
  "research",
];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ensureMemoryLayout", () => {
  it("creates all missing dirs and writes MEMORY_INDEX.md", () => {
    const memoryDir = makeTempDir();
    const result = ensureMemoryLayout({ memoryDir });

    expect(result.indexWritten).toBe(true);

    for (const relative of EXPECTED_DIRS) {
      const absolute = path.join(memoryDir, relative);
      expect(existsSync(absolute), `${relative} should exist`).toBe(true);
      expect(statSync(absolute).isDirectory()).toBe(true);
      expect(result.created).toContain(absolute);
    }

    const indexPath = path.join(memoryDir, "MEMORY_INDEX.md");
    expect(existsSync(indexPath)).toBe(true);
    const indexContent = readFileSync(indexPath, "utf8");
    expect(indexContent).toContain("宪法/规则"); // rules
    expect(indexContent).toContain("长期经验沉淀"); // long_term
    expect(indexContent).toContain("哨兵冷却态"); // alert_state.json
  });

  it("re-run is a no-op for existing dirs and does not clobber an existing index", () => {
    const memoryDir = makeTempDir();
    ensureMemoryLayout({ memoryDir });

    // Operator-curated index must survive a second run.
    const indexPath = path.join(memoryDir, "MEMORY_INDEX.md");
    const curated = "# 我手改过的导航\n";
    writeFileSync(indexPath, curated);

    const second = ensureMemoryLayout({ memoryDir });
    expect(second.created).toEqual([]); // everything already existed
    expect(second.indexWritten).toBe(false); // index not clobbered
    expect(readFileSync(indexPath, "utf8")).toBe(curated);
  });

  it("only reports dirs that were actually absent before the run", () => {
    const memoryDir = makeTempDir();
    // Pre-create one of the layout dirs so it is NOT reported as created.
    const preexisting = path.join(memoryDir, "rules");
    mkdirSync(preexisting, { recursive: true });

    const result = ensureMemoryLayout({ memoryDir });
    expect(result.created).not.toContain(preexisting);
    // Another dir that was absent should be reported.
    expect(result.created).toContain(path.join(memoryDir, "plans"));
  });
});
