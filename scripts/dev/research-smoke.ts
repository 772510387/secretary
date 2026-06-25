import { loadConfig } from "../../src/config/index.js";
import { createResearchRunner, runResearchOnce } from "../../src/app/index.js";

/**
 * Dev smoke for the real deep-research path: secretary config -> research factory
 * -> TradingAgents-CN subprocess -> adapter -> ResearchReport. Needs:
 *   RESEARCH_PROVIDER=trading_agents_cn RESEARCH_COMMAND=<venv python>
 *   RESEARCH_SCRIPT=<secretary_bridge.py> RESEARCH_CWD=<TradingAgents-CN dir>
 * and a real DASHSCOPE_API_KEY in .env.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (config.research.provider !== "trading_agents_cn") {
    console.error("请设 RESEARCH_PROVIDER=trading_agents_cn 及 RESEARCH_COMMAND/RESEARCH_SCRIPT/RESEARCH_CWD。");
    process.exit(2);
  }

  const runner = createResearchRunner(config);
  const startedAt = Date.now();
  console.log("调度多智能体深度分析中（可能数分钟）…");

  const result = await runResearchOnce({
    symbol: process.env.SMOKE_SYMBOL ?? "000636",
    market: (process.env.SMOKE_MARKET as "SSE" | "SZSE") ?? "SZSE",
    name: process.env.SMOKE_NAME ?? "风华高科",
    tradingDate: process.env.SMOKE_DATE ?? "2026-06-18",
    objective: "下周操作分析",
    runner,
  });

  const report = result.report;
  console.log(`\n耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log("provider:", report.provider, "| conclusion:", report.conclusion, "| conf:", report.confidence, "| degraded:", report.degraded);
  console.log("title:", report.title);
  console.log("summary head:", report.summary.slice(0, 400));
  console.log("findings:", report.findings.map((f) => f.category).join(", "));
  console.log("bull/bear:", report.bullBearViews.map((v) => v.side).join("/"));
  console.log("drafts:", report.tradeIntentDrafts.map((d) => `${d.side}@${d.limitPrice ?? "-"}`).join(", "));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
