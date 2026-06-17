import { describe, expect, it } from "vitest";
import {
  normalizeBrainCitations,
  normalizeBrainProposals,
} from "../../src/infrastructure/providers/brain-output-normalize.js";

describe("normalizeBrainCitations", () => {
  it("coerces string citations into citation objects", () => {
    expect(normalizeBrainCitations(["source A", "source B"])).toEqual([
      { title: "source A", sourceType: "system" },
      { title: "source B", sourceType: "system" },
    ]);
  });

  it("defaults a missing sourceType on object citations", () => {
    expect(normalizeBrainCitations([{ title: "x" }])).toEqual([
      { title: "x", sourceType: "system" },
    ]);
  });

  it("returns an empty array for undefined/null", () => {
    expect(normalizeBrainCitations(undefined)).toEqual([]);
    expect(normalizeBrainCitations(null)).toEqual([]);
  });

  it("leaves valid object citations untouched", () => {
    const valid = [{ title: "x", sourceType: "memory" }];
    expect(normalizeBrainCitations(valid)).toEqual(valid);
  });
});

describe("normalizeBrainProposals", () => {
  it("drops string proposals that cannot be salvaged", () => {
    expect(normalizeBrainProposals(["buy 000636"])).toEqual([]);
  });

  it("keeps and hardens well-formed proposals", () => {
    const result = normalizeBrainProposals([
      {
        proposalId: "weird id!!",
        type: "trade_intent_draft",
        title: "Buy 000636",
        rationale: "Momentum looks fine.",
        payload: { symbol: "000636" },
        requiresReview: false,
      },
    ]) as Array<Record<string, unknown>>;

    expect(result).toHaveLength(1);
    expect(result[0]?.proposalId).toBe("weird-id--");
    expect(result[0]?.requiresReview).toBe(true);
  });

  it("drops proposals with an unknown type or missing fields", () => {
    expect(
      normalizeBrainProposals([
        { type: "not_a_type", title: "x", rationale: "y", payload: {} },
        { type: "memory_write", title: "", rationale: "y", payload: {} },
        { type: "memory_write", title: "x", rationale: "y" },
      ]),
    ).toEqual([]);
  });

  it("returns an empty array for undefined", () => {
    expect(normalizeBrainProposals(undefined)).toEqual([]);
  });
});
