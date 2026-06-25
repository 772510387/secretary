import { loadConfig } from "../../src/config/index.js";
import { planAgentTurn } from "../../src/app/index.js";
import { createBrainProvider } from "../../src/infrastructure/providers/index.js";

/**
 * Dev smoke for model-driven turn routing: sends a few messages through the real
 * brain planner and prints the route it chose. Needs a real BRAIN_PROVIDER + key.
 *   cross-env NODE_USE_ENV_PROXY=1 tsx scripts/dev/plan-smoke.ts
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (config.brain.provider === "mock") {
    console.error("BRAIN_PROVIDER=mock 无法验证模型路由，请设为 dashscope/openai 并配好 key。");
    process.exit(2);
  }

  const brainProvider = createBrainProvider(config.brain);
  const messages = [
    "你好",
    "在吗",
    "项目现在有什么能力？",
    "我仓位重不重？有什么风险？",
    "帮我做个盘前计划",
    "给我来个收盘复盘",
    "把模拟盘清空重来",
    "建一个5万的模拟盘账户",
  ];

  for (const message of messages) {
    const startedAt = Date.now();
    const { plan, routedBy } = await planAgentTurn({ message }, { brainProvider });
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `「${message}」 [route ${elapsedMs}ms]\n  -> intent=${plan.intent}` +
        (plan.sopName ? ` sop=${plan.sopName}` : "") +
        (plan.initialCash ? ` cash=${plan.initialCash}` : "") +
        ` confirm=${plan.requiresConfirmation} routedBy=${routedBy}` +
        (plan.reply ? `\n     reply: ${plan.reply}` : ""),
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
