import { describe, expect, it } from "vitest";
import {
  detectPaperOpsCommand,
  resolveRelativePastDate,
} from "../../src/app/paper-ops-intent.js";

// 2026-06-24 09:00 Beijing is a Wednesday.
const now = "2026-06-24T01:00:00.000Z";

describe("resolveRelativePastDate (deterministic, no model)", () => {
  it("resolves this-week weekdays against today", () => {
    expect(resolveRelativePastDate("本周一", "2026-06-24")).toBe("2026-06-22");
    expect(resolveRelativePastDate("周三", "2026-06-24")).toBe("2026-06-24");
    // 这周五 on a Wednesday is still ahead — not a valid past replay target.
    expect(resolveRelativePastDate("这周五", "2026-06-24")).toBeUndefined();
  });

  it("resolves last-week weekdays", () => {
    expect(resolveRelativePastDate("上周五", "2026-06-24")).toBe("2026-06-19");
    expect(resolveRelativePastDate("上周一", "2026-06-24")).toBe("2026-06-15");
  });

  it("resolves 今天/昨天/前天/大前天 and N天前", () => {
    expect(resolveRelativePastDate("昨天", "2026-06-24")).toBe("2026-06-23");
    expect(resolveRelativePastDate("前天", "2026-06-24")).toBe("2026-06-22");
    expect(resolveRelativePastDate("大前天", "2026-06-24")).toBe("2026-06-21");
    expect(resolveRelativePastDate("3天前", "2026-06-24")).toBe("2026-06-21");
    expect(resolveRelativePastDate("三天前", "2026-06-24")).toBe("2026-06-21");
  });

  it("rejects future weekdays (下周X) as a replay target", () => {
    expect(resolveRelativePastDate("下周一", "2026-06-24")).toBeUndefined();
  });

  it("returns undefined when no relative expression is present", () => {
    expect(resolveRelativePastDate("帮我看看盘", "2026-06-24")).toBeUndefined();
  });
});

describe("detectPaperOpsCommand with relative dates", () => {
  it("resolves '模拟本周一的操作' deterministically (the reported bug)", () => {
    expect(detectPaperOpsCommand("模拟本周一的操作", now)).toEqual({
      replayDate: "2026-06-22",
    });
  });

  it("resolves '重演上周五的操作'", () => {
    expect(detectPaperOpsCommand("重演上周五的操作", now)).toEqual({
      replayDate: "2026-06-19",
    });
  });

  it("resolves '复现前天的操作'", () => {
    expect(detectPaperOpsCommand("复现前天的操作", now)).toEqual({
      replayDate: "2026-06-22",
    });
  });

  it("still resolves '模拟昨天的操作' (unchanged)", () => {
    expect(detectPaperOpsCommand("模拟昨天的操作", now)).toEqual({
      replayDate: "2026-06-23",
    });
  });

  it("does not treat a non-ops message as paper ops", () => {
    expect(detectPaperOpsCommand("本周一开会别忘了", now)).toBeUndefined();
  });
});
