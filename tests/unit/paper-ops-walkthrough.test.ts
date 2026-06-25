import { describe, expect, it, vi } from "vitest";
import {
  createWeChatBridgeState,
  detectPaperOpsCommand,
  wantsImmediatePaperExecution,
  type AgentAction,
  type WeChatBridgeDependencies,
} from "../../src/app/index.js";
import { runWeChatBridgeTurn } from "../../src/app/wechat-bridge.js";

// 2026-06-24 is a Wednesday → 本周一 = 2026-06-22.
const now = new Date("2026-06-24T02:00:00.000Z");
const nowIso = now.toISOString();

const WANGDING = "把本周一的流程走一遍，对于时间点后的数据要遮掩，然后有行为操作，直接落盘数据库就行";

describe("detectPaperOpsCommand — 走一遍/落盘 colloquial replay", () => {
  it("routes 王鼎's '把本周一的流程走一遍…直接落盘数据库' to a Monday replay + archive", () => {
    const command = detectPaperOpsCommand(WANGDING, nowIso);
    expect(command).toBeDefined();
    expect(command!.replayDate).toBe("2026-06-22");
    expect(command!.archiveDate).toBe("2026-06-24");
  });

  it("matches '跑一遍周一' and '过一遍昨天的节点'", () => {
    expect(detectPaperOpsCommand("跑一遍本周一", nowIso)?.replayDate).toBe("2026-06-22");
    expect(detectPaperOpsCommand("帮我过一遍昨天的节点流程", nowIso)?.replayDate).toBe("2026-06-23");
  });

  it("does NOT fire on a plain read-only review question", () => {
    expect(detectPaperOpsCommand("本周一复盘看看就好", nowIso)).toBeUndefined();
    expect(detectPaperOpsCommand("昨天大盘怎么样", nowIso)).toBeUndefined();
  });
});

describe("wantsImmediatePaperExecution", () => {
  it("detects explicit execute-now / skip-confirm phrasing", () => {
    expect(wantsImmediatePaperExecution(WANGDING)).toBe(true);
    expect(wantsImmediatePaperExecution("直接执行就行")).toBe(true);
    expect(wantsImmediatePaperExecution("不用确认，直接落库")).toBe(true);
    expect(wantsImmediatePaperExecution("马上跑一遍")).toBe(true);
  });

  it("does not fire on a neutral request", () => {
    expect(wantsImmediatePaperExecution("把本周一的操作重演一下")).toBe(false);
    expect(wantsImmediatePaperExecution("看看持仓")).toBe(false);
  });
});

describe("runWeChatBridgeTurn — owner '直接…就行' auto-executes the masked replay", () => {
  it("executes the paper op immediately instead of staging a confirmation", async () => {
    const executeAction = vi.fn(async (action: AgentAction) => {
      expect(action.type).toBe("paper_ops");
      if (action.type === "paper_ops") {
        expect(action.replayDate).toBe("2026-06-22");
      }
      return "已忠实重演 2026-06-22；后端 2 笔纸面成交已写库。";
    });
    const deps: WeChatBridgeDependencies = {
      brainProvider: { providerName: "mock", generate: async () => { throw new Error("unused"); } },
      isAllowed: () => true,
      allowDestructive: () => true,
      loadContext: () => ({}),
      executeAction,
      now: () => now,
    };

    const reply = await runWeChatBridgeTurn({ peerId: "boss", text: WANGDING }, deps, createWeChatBridgeState());

    expect(executeAction).toHaveBeenCalledOnce();
    expect(reply.reply).toContain("已直接执行");
    expect(reply.reply).toContain("已写库");
  });

  it("still stages a confirmation when the owner does NOT say 直接/就行", async () => {
    const executeAction = vi.fn(async () => "done");
    const deps: WeChatBridgeDependencies = {
      brainProvider: { providerName: "mock", generate: async () => { throw new Error("unused"); } },
      isAllowed: () => true,
      allowDestructive: () => true,
      loadContext: () => ({}),
      executeAction,
      now: () => now,
    };

    const reply = await runWeChatBridgeTurn(
      { peerId: "boss", text: "把本周一的操作重演一下" },
      deps,
      createWeChatBridgeState(),
    );

    expect(executeAction).not.toHaveBeenCalled();
    expect(reply.reply).toContain("确认");
  });
});
