import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountSchema, positionSchema } from "../../src/domain/portfolio/index.js";
import { z } from "zod";
import { main as runTradeCli } from "../../scripts/dev/trade.js";

const tempRoots: string[] = [];
const positionsSchema = z.array(positionSchema);

describe("trade CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();

    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("places a paper buy that updates the simulation DB", async () => {
    const memoryDir = seedAccount({ available: 20000 });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runTradeCli(["buy", "000636", "100", "12", "--memory-dir", memoryDir]);

    const account = accountSchema.parse(readJson(path.join(memoryDir, "portfolio", "account.json")));
    const positions = positionsSchema.parse(
      readJson(path.join(memoryDir, "portfolio", "positions.json")),
    );

    // 100 shares @ 12 = 1200 spent (no fees configured) -> 18800 left.
    expect(account.cash.available).toBe(18800);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      symbol: "000636",
      market: "SZSE",
      quantity: 100,
      todayBuyQuantity: 100,
      costPrice: 12,
    });
  });
});

function seedAccount(options: { available: number }): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-trade-cli-"));
  tempRoots.push(root);
  const memoryDir = path.join(root, "memory");
  const portfolioDir = path.join(memoryDir, "portfolio");
  mkdirSync(portfolioDir, { recursive: true });

  const now = "2026-06-17T01:30:00.000Z";
  writeFileSync(
    path.join(portfolioDir, "account.json"),
    JSON.stringify(
      accountSchema.parse({
        accountId: "paper-main",
        type: "paper",
        baseCurrency: "CNY",
        initialCash: 20000,
        cash: { available: options.available, frozen: 0 },
        status: "active",
        createdAt: now,
        updatedAt: now,
      }),
      null,
      2,
    ),
  );
  writeFileSync(path.join(portfolioDir, "positions.json"), "[]");

  return memoryDir;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}
