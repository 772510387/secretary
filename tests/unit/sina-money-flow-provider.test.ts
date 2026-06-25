import { describe, expect, it } from "vitest";
import {
  SinaMoneyFlowProvider,
  MoneyFlowProviderError,
  parseSinaMoneyFlow,
  parseSinaMoneyFlowRanking,
  type SinaFetchResponse,
} from "../../src/infrastructure/providers/index.js";

// Real Sina MoneyFlow.ssl_qsfx_zjlrqs response for sh600519 on 2026-06-25 (latest day).
const sample =
  '[{"opendate":"2026-06-25","trade":"1212.9000","changeratio":"0.00432234","turnover":"38.2529","netamount":"91610683.4000","ratioamount":"0.0158374","r0_net":"336098912.4500","r0_ratio":"0.05810377","r0x_ratio":"85.7456","cnt_r0x_ratio":"1","cate_ra":"0.0821018","cate_na":"1828619171.3200"}]';

function ok(text: string): SinaFetchResponse {
  return { ok: true, status: 200, text: async () => text };
}

describe("parseSinaMoneyFlow", () => {
  it("maps the latest row to 主力净流入 (r0_net), ratio in %, overall netamount", () => {
    const flow = parseSinaMoneyFlow(sample, "600519");
    expect(flow).toMatchObject({
      symbol: "600519",
      date: "2026-06-25",
      mainNetInflow: 336098912.45, // r0_net (主力净流入), yuan
      netInflow: 91610683.4, // netamount (全单净流入)
    });
    expect(flow?.mainNetInflowRatio).toBeCloseTo(5.810377, 4); // r0_ratio × 100
  });

  it("returns undefined for an empty array, throws on bad JSON", () => {
    expect(parseSinaMoneyFlow("[]", "600519")).toBeUndefined();
    expect(() => parseSinaMoneyFlow("nope", "600519")).toThrow(MoneyFlowProviderError);
  });
});

describe("parseSinaMoneyFlowRanking", () => {
  it("maps the batch ranking to 6-digit symbol → 主力净流入 (r0_net)", () => {
    // Real ssl_bkzj_ssggzj rows (trimmed).
    const text =
      '[{"symbol":"sz300502","name":"\\u65b0\\u6613\\u76db","amount":"40588348021.0000","netamount":"6929211821.6400","r0_net":"6923437330.4000"},' +
      '{"symbol":"sh600584","name":"长电科技","amount":"36109394706","netamount":"4111744166","r0_net":"4111744166.96"},' +
      '{"symbol":"bj920249","name":"x","r0_net":"-"}]'; // bad r0_net dropped
    const map = parseSinaMoneyFlowRanking(text);
    expect(map.get("300502")).toBeCloseTo(6923437330.4, 0);
    expect(map.get("600584")).toBeCloseTo(4111744166.96, 0);
    expect(map.has("920249")).toBe(false);
  });

  it("returns an empty map on bad JSON", () => {
    expect(parseSinaMoneyFlowRanking("nope").size).toBe(0);
  });
});

describe("SinaMoneyFlowProvider", () => {
  it("requests by daima and returns the parsed flow", async () => {
    let url = "";
    const provider = new SinaMoneyFlowProvider({
      fetchImpl: async (u) => {
        url = u;
        return ok(sample);
      },
    });
    const flow = await provider.getMoneyFlow({ symbol: "600519", market: "SSE", name: "贵州茅台" });
    expect(url).toContain("daima=sh600519");
    expect(flow?.mainNetInflow).toBe(336098912.45);
  });

  it("getMoneyFlows skips per-symbol failures and keys by symbol", async () => {
    const provider = new SinaMoneyFlowProvider({
      fetchImpl: async (u) => (u.includes("sz000001") ? { ok: false, status: 500, text: async () => "" } : ok(sample)),
    });
    const map = await provider.getMoneyFlows([
      { symbol: "600519", market: "SSE", name: "茅台" },
      { symbol: "000001", market: "SZSE", name: "平安银行" },
    ]);
    expect(map.has("600519")).toBe(true);
    expect(map.has("000001")).toBe(false); // failed fetch omitted, no throw
  });
});
