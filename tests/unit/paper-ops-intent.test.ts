import { describe, expect, it } from "vitest";
import {
  detectPaperOpsCommand,
  resolveRelativePastDate,
  resolveReplayNode,
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

describe("resolveReplayNode (单个闹钟场景重演)", () => {
  it("maps time/name phrases to a single alarm node", () => {
    expect(resolveReplayNode("早上八点的闹钟")).toBe("data_warmup");
    expect(resolveReplayNode("9:15 集合竞价")).toBe("call_auction_watch");
    expect(resolveReplayNode("尾盘那个节点")).toBe("late_session_plan");
    expect(resolveReplayNode("盘前计划")).toBe("pre_market_plan");
  });

  it("matches the most specific alias first (八点半 ≠ 八点)", () => {
    expect(resolveReplayNode("八点半")).toBe("pre_market_plan"); // not data_warmup(八点)
    expect(resolveReplayNode("八点")).toBe("data_warmup");
    expect(resolveReplayNode("八点一刻")).toBe("overnight_digest");
  });

  it("returns undefined when no node phrase is present", () => {
    expect(resolveReplayNode("重演昨天的操作")).toBeUndefined();
  });
});

describe("detectPaperOpsCommand single-node scope", () => {
  it("scopes a replay to one node when the message names it", () => {
    expect(detectPaperOpsCommand("重演昨天的集合竞价节点", now)).toEqual({
      replayDate: "2026-06-23",
      node: "call_auction_watch",
    });
  });

  it("scopes today's simulate to one node (早上八点)", () => {
    const command = detectPaperOpsCommand("模拟今天早上八点的闹钟操作", now);
    expect(command?.simulateDate).toBe("2026-06-24");
    expect(command?.node).toBe("data_warmup");
  });

  it("leaves node undefined for a whole-day replay", () => {
    expect(detectPaperOpsCommand("重演昨天的操作", now)).toEqual({ replayDate: "2026-06-23" });
  });
});
