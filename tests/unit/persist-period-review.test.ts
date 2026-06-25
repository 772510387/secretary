import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPeriodReviewPath,
  persistPeriodReview,
} from "../../src/app/index.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function tempMemoryDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "period-review-"));
  roots.push(root);
  return path.join(root, "memory");
}

describe("persistPeriodReview", () => {
  it("writes weekly review markdown and appends reruns without clobbering", () => {
    const memoryDir = tempMemoryDir();
    const generatedAt = "2026-06-13T02:00:00.000Z";

    const first = persistPeriodReview({
      memoryDir,
      reviewType: "weekly_review",
      generatedAt,
      title: "周复盘",
      report: "第一版复盘 token=secret-value",
      metadata: { liveTrading: false },
    });
    const second = persistPeriodReview({
      memoryDir,
      reviewType: "weekly_review",
      generatedAt: "2026-06-13T03:00:00.000Z",
      title: "周复盘",
      report: "第二版复盘",
    });

    const expectedPath = createPeriodReviewPath(memoryDir, "weekly_review", generatedAt);
    expect(first.path).toBe(expectedPath);
    expect(second.path).toBe(expectedPath);
    expect(first.appended).toBe(false);
    expect(second.appended).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);

    const body = readFileSync(expectedPath, "utf8");
    expect(body).toContain("# 周复盘 · 2026-06-13");
    expect(body.match(/## 周复盘/g)?.length).toBe(2);
    expect(body).not.toContain("secret-value");
    expect(body).toContain("token=[redacted]");
  });

  it("uses month and year scoped paths for monthly and yearly reviews", () => {
    const memoryDir = tempMemoryDir();

    expect(createPeriodReviewPath(memoryDir, "monthly_review", "2026-06-30T12:00:00.000Z")).toBe(
      path.join(memoryDir, "monthly_reviews", "2026", "2026-06.md"),
    );
    expect(createPeriodReviewPath(memoryDir, "yearly_review", "2026-12-31T12:00:00.000Z")).toBe(
      path.join(memoryDir, "yearly_reviews", "2026.md"),
    );
  });
});
