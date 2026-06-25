import { describe, expect, it } from "vitest";
import {
  brainOutputSchema,
  buildTurnPlannerBrainInput,
  parseTurnPlan,
  turnPlanNeedsContext,
  type BrainInput,
  type BrainOutput,
} from "../../src/domain/brain/index.js";
import { sopCatalogForPrompt } from "../../src/domain/cerebellum/index.js";

const now = "2026-06-21T01:00:00.000Z";

function brainOutput(input: BrainInput, structured: unknown): BrainOutput {
  return brainOutputSchema.parse({
    requestId: input.requestId,
    provider: "mock",
    model: "mock-brain-v1",
    taskType: input.taskType,
    generatedAt: now,
    summary: "路由判断。",
    structured,
    citations: [],
    confidence: 0.5,
    proposals: [],
  });
}

describe("buildTurnPlannerBrainInput", () => {
  it("builds a valid user_query brain input that carries the SOP catalog and message", () => {
    const input = buildTurnPlannerBrainInput({
      message: "帮我做个盘前计划",
      now,
      sopCatalog: sopCatalogForPrompt(),
    });

    expect(input.taskType).toBe("user_query");
    expect((input.context as { router?: boolean }).router).toBe(true);
    expect(input.prompt).toContain("pre-market-plan");
    expect(input.prompt).toContain("帮我做个盘前计划");
    expect(input.requestId).toMatch(/^turn-plan-/);
  });
});

describe("parseTurnPlan", () => {
  it("parses a well-formed route from the structured field", () => {
    const input = buildTurnPlannerBrainInput({ message: "x", now, sopCatalog: sopCatalogForPrompt() });
    const plan = parseTurnPlan(
      brainOutput(input, { intent: "run_sop", sopName: "pre-market-plan", routeReason: "用户想要盘前计划" }),
    );

    expect(plan).not.toBeNull();
    expect(plan?.intent).toBe("run_sop");
    expect(plan?.sopName).toBe("pre-market-plan");
  });

  it("parses a paper_ops route with operation dates", () => {
    const input = buildTurnPlannerBrainInput({ message: "x", now, sopCatalog: sopCatalogForPrompt() });
    const plan = parseTurnPlan(
      brainOutput(input, {
        intent: "paper_ops",
        replayDate: "2026-06-22",
        simulateDate: "2026-06-23",
        archiveDate: "2026-06-23",
        requiresConfirmation: true,
      }),
    );

    expect(plan).toMatchObject({
      intent: "paper_ops",
      replayDate: "2026-06-22",
      simulateDate: "2026-06-23",
      archiveDate: "2026-06-23",
    });
  });

  it("returns null for an empty or malformed structured output (so callers can fall back)", () => {
    const input = buildTurnPlannerBrainInput({ message: "x", now, sopCatalog: sopCatalogForPrompt() });
    expect(parseTurnPlan(brainOutput(input, {}))).toBeNull();
    expect(parseTurnPlan(brainOutput(input, { intent: "not-a-real-intent" }))).toBeNull();
  });
});

describe("turnPlanNeedsContext", () => {
  it("requires context only for chat and SOP turns", () => {
    expect(turnPlanNeedsContext("chat")).toBe(true);
    expect(turnPlanNeedsContext("run_sop")).toBe(true);
    expect(turnPlanNeedsContext("smalltalk")).toBe(false);
    expect(turnPlanNeedsContext("capabilities")).toBe(false);
    expect(turnPlanNeedsContext("reset_paper")).toBe(false);
    expect(turnPlanNeedsContext("seed_paper")).toBe(false);
    expect(turnPlanNeedsContext("paper_ops")).toBe(false);
  });
});
