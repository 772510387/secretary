import { describe, expect, it } from "vitest";
import {
  buildNodeDisplayContract,
  FEISHU_PERSONA_CONTRACT,
} from "../../src/app/display-contract.js";

describe("FEISHU_PERSONA_CONTRACT", () => {
  it("carries persona, honesty markers and the Boss summary closer", () => {
    expect(FEISHU_PERSONA_CONTRACT).toContain("小蜜");
    expect(FEISHU_PERSONA_CONTRACT).toContain("数据缺失");
    expect(FEISHU_PERSONA_CONTRACT).toContain("Boss 摘要");
  });
});

describe("buildNodeDisplayContract", () => {
  it("pre-market node keeps the market-background block", () => {
    const contract = buildNodeDisplayContract("pre_market_plan");
    expect(contract).toContain("市场背景");
    expect(contract).toContain("连板股");
  });

  it("call-auction node adds the 一字板/题材/封单 three-list", () => {
    const contract = buildNodeDisplayContract("call_auction_watch");
    expect(contract).toContain("竞价一字板");
    expect(contract).toContain("题材");
    expect(contract).toContain("封单");
  });

  it("intraday review node uses the 观察→判断→下次复查 skeleton", () => {
    const contract = buildNodeDisplayContract("morning_review");
    expect(contract).toContain("观察");
    expect(contract).toContain("判断");
    expect(contract).toContain("下次复查");
  });

  it("evening node uses the 盘后复盘 skeleton", () => {
    const contract = buildNodeDisplayContract("deep_review");
    expect(contract).toContain("最终战绩");
    expect(contract).toContain("知识沉淀");
  });

  it("period node uses the 周期复盘 skeleton", () => {
    const contract = buildNodeDisplayContract("weekly_review");
    expect(contract).toContain("最大回撤");
  });

  it("returns undefined for nodes that need only the shared persona", () => {
    expect(buildNodeDisplayContract("data_warmup")).toBeUndefined();
    expect(buildNodeDisplayContract(undefined)).toBeUndefined();
  });
});
