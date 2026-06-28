import { describe, expect, it } from "vitest";
import {
  ConceptProviderError,
  EastmoneyConceptProvider,
  parseConceptList,
} from "../../src/infrastructure/providers/index.js";
import type { UniverseFetchResponse } from "../../src/infrastructure/providers/index.js";

// Real Eastmoney clist shapes (fs=m:90+t:3 concept list; fs=b:BK#### members).
const CONCEPT_LIST = JSON.stringify({
  rc: 0,
  data: {
    total: 494,
    diff: [
      { f12: "BK1128", f14: "CPO概念", f3: 5.2, f62: 1.2e9 },
      { f12: "BK0968", f14: "固态电池", f3: 3.1, f62: 8e8 },
      { f12: "BK1184", f14: "人形机器人", f3: -1.4, f62: -2e8 },
      { f12: "999999", f14: "不是板块", f3: 9 }, // non-BK row → dropped
    ],
  },
});

const CPO_MEMBERS = JSON.stringify({
  rc: 0,
  data: {
    total: 3,
    diff: {
      "0": { f12: "001309", f13: 0, f14: "德明利", f2: 84.9, f3: 10.0, f5: 1, f6: 5e9, f8: 2, f20: 1e10 },
      "1": { f12: "603773", f13: 1, f14: "沃格光电", f2: 130, f3: 8.0, f5: 1, f6: 2e9, f8: 3, f20: 8e9 },
      "2": { f12: "300618", f13: 0, f14: "寒锐钴业", f2: 50, f3: 5, f5: 1, f6: 1e9, f8: 1, f20: 5e9 }, // 创业板
    },
  },
});

function ok(text: string): UniverseFetchResponse {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseConceptList", () => {
  it("keeps only BK concept boards with a name", () => {
    const boards = parseConceptList(CONCEPT_LIST);
    expect(boards.map((b) => b.boardCode)).toEqual(["BK1128", "BK0968", "BK1184"]);
    expect(boards[0]).toMatchObject({ name: "CPO概念", changePct: 5.2 });
  });

  it("throws on bad JSON, returns [] when no diff", () => {
    expect(() => parseConceptList("nope")).toThrow(ConceptProviderError);
    expect(parseConceptList(JSON.stringify({ data: {} }))).toEqual([]);
  });
});

describe("EastmoneyConceptProvider", () => {
  it("getHotConcepts ranks/filters by board 涨幅 and caps to topK", async () => {
    const provider = new EastmoneyConceptProvider({ fetchImpl: async () => ok(CONCEPT_LIST) });
    const hot = await provider.getHotConcepts({ topK: 2, minChangePct: 0 });
    expect(hot.map((c) => c.name)).toEqual(["CPO概念", "固态电池"]); // 人形机器人 (-1.4%) filtered by minChangePct 0
  });

  it("getConceptMembers reuses the universe row parser (real codes + market)", async () => {
    let calledUrl = "";
    const provider = new EastmoneyConceptProvider({
      fetchImpl: async (url) => {
        calledUrl = url;
        return ok(CPO_MEMBERS);
      },
    });
    const members = await provider.getConceptMembers("BK1128");
    expect(calledUrl).toContain("fs=b:BK1128");
    expect(members.map((m) => m.symbol)).toEqual(["001309", "603773", "300618"]);
    expect(members.find((m) => m.symbol === "001309")).toMatchObject({ market: "SZSE", name: "德明利", changePct: 10 });
  });

  it("rejects a non-BK board code without a request", async () => {
    let called = false;
    const provider = new EastmoneyConceptProvider({
      fetchImpl: async () => {
        called = true;
        return ok(CPO_MEMBERS);
      },
    });
    expect(await provider.getConceptMembers("600000")).toEqual([]);
    expect(called).toBe(false);
  });
});
