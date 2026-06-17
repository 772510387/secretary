import { describe, expect, it } from "vitest";
import { runAskOnce } from "../../src/app/index.js";
import {
  accountSchema,
  positionSchema,
  type Account,
  type Position,
} from "../../src/domain/portfolio/index.js";
import {
  brainInputSchema,
  type BrainInput,
  type BrainOutput,
  type BrainProvider,
} from "../../src/domain/brain/index.js";

const now = "2026-06-16T02:00:00.000Z";

class CapturingBrainProvider implements BrainProvider {
  readonly providerName = "mock" as const;
  lastInput?: BrainInput;

  async generate(input: BrainInput): Promise<BrainOutput> {
    this.lastInput = brainInputSchema.parse(input);

    return {
      requestId: input.requestId,
      provider: this.providerName,
      model: "mock-brain-v1",
      taskType: input.taskType,
      generatedAt: now,
      summary: "账户健康，仓位适中。",
      structured: { stance: "neutral" },
      citations: [],
      confidence: 0.6,
      proposals: [],
    };
  }
}

describe("runAskOnce", () => {
  it("values the DB, feeds context to the model, and returns the answer", async () => {
    const brain = new CapturingBrainProvider();
    const result = await runAskOnce(
      {
        question: "我现在仓位重不重？",
        account: makeAccount({ available: 8000 }),
        positions: [makePosition()],
        prices: { "000636": 12 },
        now,
      },
      { brainProvider: brain },
    );

    expect(result.answer).toBe("账户健康，仓位适中。");
    expect(result.provider).toBe("mock");
    expect(result.pricesAvailable).toBe(true);

    // The model is asked as a user_query with the DB valuation in context.
    expect(brain.lastInput?.taskType).toBe("user_query");
    const context = brain.lastInput?.context as Record<string, unknown>;
    const account = context.account as Record<string, unknown>;
    expect(account.availableCash).toBe(8000);
    const positions = context.positions as Array<Record<string, unknown>>;
    expect(positions[0]).toMatchObject({ symbol: "000636", latestPrice: 12 });

    // Mark-to-market: 100 shares at 12 vs cost 10 -> +200 unrealized.
    expect(result.valuation.positions[0]?.unrealizedPnl).toBe(200);
    expect(result.auditEvent).toMatchObject({
      action: "read",
      subject: { type: "account", id: "paper-main" },
      result: "success",
    });
  });

  it("values at cost when no prices are supplied", async () => {
    const result = await runAskOnce(
      {
        question: "账户情况？",
        account: makeAccount(),
        positions: [makePosition()],
        now,
      },
      { brainProvider: new CapturingBrainProvider() },
    );

    expect(result.pricesAvailable).toBe(false);
    expect(result.valuation.positions[0]?.latestPrice).toBe(10);
    expect(result.valuation.positions[0]?.unrealizedPnl).toBe(0);
  });

  it("rejects an empty question", async () => {
    await expect(
      runAskOnce(
        { question: "   ", account: makeAccount(), positions: [], now },
        { brainProvider: new CapturingBrainProvider() },
      ),
    ).rejects.toThrow(/must not be empty/);
  });
});

function makeAccount(overrides: { available?: number; frozen?: number } = {}): Account {
  return accountSchema.parse({
    accountId: "paper-main",
    type: "paper",
    baseCurrency: "CNY",
    initialCash: 20000,
    cash: {
      available: overrides.available ?? 20000,
      frozen: overrides.frozen ?? 0,
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function makePosition(overrides: Partial<Parameters<typeof positionSchema.parse>[0]> = {}): Position {
  return positionSchema.parse({
    accountId: "paper-main",
    symbol: "000636",
    market: "SZSE",
    name: "Fenghua Hi-Tech",
    quantity: 100,
    availableQuantity: 100,
    todayBuyQuantity: 0,
    frozenQuantity: 0,
    costPrice: 10,
    latestPrice: 10,
    currency: "CNY",
    openedAt: now,
    updatedAt: now,
    ...overrides,
  });
}
