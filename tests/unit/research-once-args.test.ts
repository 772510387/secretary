import { describe, expect, it } from "vitest";
import {
  ResearchOnceCliError,
  parseResearchOnceArgs,
} from "../../scripts/dev/research-once.js";

describe("research-once CLI argument parsing", () => {
  it("parses required and optional arguments", () => {
    const parsed = parseResearchOnceArgs([
      "--symbol",
      "000636",
      "--market",
      "SZSE",
      "--date",
      "2026-06-13",
      "--objective",
      "Generate one safe research report.",
      "--name",
      "Fenghua Hi-Tech",
      "--task-id",
      "research-task-custom",
      "--at",
      "2026-06-13T08:30:00.000Z",
      "--memory-dir",
      "tmp-memory",
    ]);

    expect(parsed).toEqual({
      help: false,
      symbol: "000636",
      market: "SZSE",
      date: "2026-06-13",
      objective: "Generate one safe research report.",
      name: "Fenghua Hi-Tech",
      taskId: "research-task-custom",
      at: "2026-06-13T08:30:00.000Z",
      memoryDir: "tmp-memory",
    });
  });

  it("accepts --trading-date as a date alias", () => {
    const parsed = parseResearchOnceArgs([
      "--symbol",
      "600000",
      "--market",
      "SSE",
      "--trading-date",
      "2026-06-13",
      "--objective",
      "Generate one safe research report.",
    ]);

    expect(parsed).toMatchObject({
      help: false,
      date: "2026-06-13",
    });
  });

  it("returns help without requiring research parameters", () => {
    expect(parseResearchOnceArgs(["--help"])).toEqual({
      help: true,
    });
  });

  it("reports all missing required arguments", () => {
    expect(() => parseResearchOnceArgs(["--symbol", "000636"])).toThrow(
      new ResearchOnceCliError("Missing required argument(s): --market, --date, --objective"),
    );
  });

  it("rejects invalid market, symbol, date, and unknown arguments", () => {
    expect(() =>
      parseResearchOnceArgs([
        "--symbol",
        "00063",
        "--market",
        "SZSE",
        "--date",
        "2026-06-13",
        "--objective",
        "Generate one safe research report.",
      ]),
    ).toThrow("--symbol must be a 6-digit A-share symbol");

    expect(() =>
      parseResearchOnceArgs([
        "--symbol",
        "000636",
        "--market",
        "BSE",
        "--date",
        "2026-06-13",
        "--objective",
        "Generate one safe research report.",
      ]),
    ).toThrow("--market must be SSE or SZSE");

    expect(() =>
      parseResearchOnceArgs([
        "--symbol",
        "000636",
        "--market",
        "SZSE",
        "--date",
        "20260613",
        "--objective",
        "Generate one safe research report.",
      ]),
    ).toThrow("--date must use YYYY-MM-DD");

    expect(() => parseResearchOnceArgs(["--provider", "trading_agents_cn"])).toThrow(
      "Unknown argument: --provider",
    );
  });

  it("rejects missing values", () => {
    expect(() => parseResearchOnceArgs(["--symbol"])).toThrow("Missing value for --symbol");
    expect(() => parseResearchOnceArgs(["--symbol", "--market"])).toThrow(
      "Missing value for --symbol",
    );
  });
});
