import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runReplay, type ReplayReport } from "../../src/runtime/index.js";
import { FixtureHistoryProvider } from "../../src/infrastructure/providers/index.js";
import { FIXED_CEREBELLUM_ALARM_RULES } from "../../src/domain/cerebellum/index.js";
import {
  replayAccount,
  replayBarsBySymbol,
  replayPositions,
} from "../fixtures/replay/fixtures.js";

const GOLDEN_DIR = fileURLToPath(new URL("./golden", import.meta.url));
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === "1";

// A focused subset proving the as-of boundary: 08:30 (pre-close), 15:00 (pre-close),
// 15:30 (post-close), over two weekdays (2026-06-18 Thu, 2026-06-19 Fri).
const SUBSET_IDS = new Set(["pre-market-plan", "closing-snapshot", "post-close-review"]);
const SUBSET_ALARMS = FIXED_CEREBELLUM_ALARM_RULES.filter((rule) => SUBSET_IDS.has(rule.alarmId));

let report: ReplayReport;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "replay-golden-"));
  let counter = 0;
  report = await runReplay({
    startDate: "2026-06-18",
    endDate: "2026-06-19",
    account: replayAccount(),
    positions: replayPositions(),
    historyProvider: new FixtureHistoryProvider(replayBarsBySymbol()),
    memoryDir: tmpDir,
    alarms: SUBSET_ALARMS,
    historyCount: 60,
    reason: "replay",
    idGenerator: () => `evt-${String((counter += 1)).padStart(4, "0")}`,
  });
});

afterAll(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("replay golden regression", () => {
  it("writes one snapshot per due node over the window (3 nodes x 2 weekdays)", () => {
    expect(report.totalWritten).toBe(6);
    expect(report.snapshots).toHaveLength(6);
  });

  it("matches committed golden snapshots (deep equal; UPDATE_GOLDEN=1 regenerates)", () => {
    for (const record of report.snapshots) {
      const produced = JSON.parse(readFileSync(record.filePath, "utf8"));
      const goldenPath = path.join(GOLDEN_DIR, record.asOfDate, `${record.snapshotId}.json`);

      if (UPDATE_GOLDEN) {
        mkdirSync(path.dirname(goldenPath), { recursive: true });
        writeFileSync(goldenPath, `${JSON.stringify(produced, null, 2)}\n`);
        continue;
      }

      expect(
        existsSync(goldenPath),
        `missing golden ${goldenPath} — run UPDATE_GOLDEN=1 to generate`,
      ).toBe(true);
      expect(produced).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
    }
  });

  it("enforces the post-close boundary: 08:30/15:00 value prior day, 15:30 same day", () => {
    const onFriday = (alarmId: string) =>
      report.snapshots.find((snap) => snap.alarmId === alarmId && snap.asOfDate === "2026-06-19")!;
    const preMarket = onFriday("pre-market-plan"); // 08:30, exclusive
    const closing = onFriday("closing-snapshot"); // 15:00, exclusive
    const postClose = onFriday("post-close-review"); // 15:30, inclusive

    expect(preMarket.sameDayBarIncluded).toBe(false);
    expect(closing.sameDayBarIncluded).toBe(false);
    expect(postClose.sameDayBarIncluded).toBe(true);

    const technicalDate = (filePath: string): string =>
      JSON.parse(readFileSync(filePath, "utf8")).market.technicals[0].asOfDate;
    expect(technicalDate(preMarket.filePath)).toBe("2026-06-18");
    expect(technicalDate(closing.filePath)).toBe("2026-06-18");
    expect(technicalDate(postClose.filePath)).toBe("2026-06-19");
  });

  it("persists no future-dated data and no stale on-disk price", () => {
    for (const record of report.snapshots) {
      const snapshot = JSON.parse(readFileSync(record.filePath, "utf8"));

      for (const position of snapshot.positions) {
        expect(position.latestPrice).toBeUndefined(); // stripped to block the stale-price leak
      }
      for (const technical of snapshot.market.technicals) {
        expect(technical.asOfDate <= snapshot.asOfDate).toBe(true);
      }
      for (const date of Object.values(snapshot.metadata.historyAsOfDates) as string[]) {
        expect(date <= snapshot.asOfDate).toBe(true);
      }
    }
  });

  it("redacts audit metadata (no per-position pnl / latestPrice / costPrice)", () => {
    let eventCount = 0;
    for (const date of ["2026-06-18", "2026-06-19"]) {
      const auditPath = path.join(tmpDir, "logs", `audit-${date}.jsonl`);
      if (!existsSync(auditPath)) {
        continue;
      }
      for (const line of readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)) {
        const event = JSON.parse(line);
        eventCount += 1;
        expect(event.subject.type).toBe("memory");
        const keys = Object.keys(event.metadata);
        expect(keys).toContain("totalAssets");
        expect(keys).not.toContain("latestPrice");
        expect(keys).not.toContain("unrealizedPnl");
        expect(keys).not.toContain("costPrice");
        expect(event.metadata.liveTrading).toBe(false);
      }
    }
    expect(eventCount).toBe(6);
  });
});
