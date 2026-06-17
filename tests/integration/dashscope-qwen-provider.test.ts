import { describe, expect, it } from "vitest";
import { brainInputSchema } from "../../src/domain/brain/index.js";
import { DashScopeQwenProvider } from "../../src/infrastructure/providers/index.js";

describe("DashScopeQwenProvider network smoke test", () => {
  it.skipIf(process.env.DASHSCOPE_BRAIN_NETWORK !== "1")(
    "can query DashScope when explicitly enabled",
    async () => {
      if (!process.env.DASHSCOPE_API_KEY) {
        throw new Error("DASHSCOPE_API_KEY is required when DASHSCOPE_BRAIN_NETWORK=1");
      }

      const provider = new DashScopeQwenProvider({
        apiKey: process.env.DASHSCOPE_API_KEY,
        model: process.env.DASHSCOPE_BRAIN_MODEL ?? "qwen-plus",
        timeoutMs: 30_000,
        maxTokens: 800,
      });
      const output = await provider.generate(
        brainInputSchema.parse({
          requestId: "dashscope-smoke-001",
          taskType: "user_query",
          prompt:
            "Return a compact valid BrainOutput JSON object. Do not execute tools. Answer with JSON only.",
          context: {
            smoke: true,
            liveTrading: false,
          },
        }),
      );

      expect(output).toMatchObject({
        requestId: "dashscope-smoke-001",
        provider: "dashscope",
        taskType: "user_query",
      });
      expect(output.proposals.every((proposal) => proposal.requiresReview === true)).toBe(true);
    },
  );
});
