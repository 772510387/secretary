import {
  auditEventSchema,
  type AuditEvent,
} from "../domain/audit/index.js";
import {
  brainInputSchema,
  type BrainOutput,
  type BrainProvider,
} from "../domain/brain/index.js";
import {
  calculatePortfolioValuation,
  type Account,
  type PortfolioValuation,
  type Position,
} from "../domain/portfolio/index.js";
import type { JsonValue } from "../domain/shared/index.js";

export interface AskPortfolioInput {
  question: string;
  account: Account;
  positions: Position[];
  /** Latest prices by symbol for mark-to-market; omit to value at cost. */
  prices?: Record<string, number>;
  t1Enabled?: boolean;
  requestId?: string;
  now?: string;
  metadata?: Record<string, JsonValue>;
}

export interface AskPortfolioDependencies {
  brainProvider: BrainProvider;
}

export interface AskPortfolioResult {
  requestId: string;
  generatedAt: string;
  question: string;
  valuation: PortfolioValuation;
  pricesAvailable: boolean;
  answer: string;
  structured: JsonValue;
  citations: BrainOutput["citations"];
  confidence: number;
  provider: string;
  model: string;
  auditEvent: AuditEvent;
  metadata: Record<string, JsonValue>;
}

/**
 * Answers a natural-language question about the current paper account using the
 * configured brain provider.
 *
 * It is read-only: it values the account from the stored DB (optionally marked
 * to market with injected prices), feeds a compact de-identified context to the
 * model, and returns the model's answer. The model cannot execute tools, place
 * orders, or write the account; any trade idea must stay a review-required
 * proposal (enforced by the BrainOutput contract and validation).
 */
export async function runAskOnce(
  input: AskPortfolioInput,
  dependencies: AskPortfolioDependencies,
): Promise<AskPortfolioResult> {
  const question = input.question.trim();

  if (!question) {
    throw new AskPortfolioError("question must not be empty");
  }

  const generatedAt = normalizeNow(input.now);
  const requestId = (input.requestId ?? `ask-${Date.parse(generatedAt)}`).slice(0, 128);
  const pricesAvailable = Boolean(input.prices && Object.keys(input.prices).length > 0);
  const valuation = calculatePortfolioValuation(input.account, input.positions, {
    prices: input.prices,
    t1Enabled: input.t1Enabled ?? true,
  });
  const context = buildAskContext(valuation, pricesAvailable, generatedAt);

  const brainInput = brainInputSchema.parse({
    requestId,
    taskType: "user_query",
    prompt: [
      question,
      "",
      "请只根据提供的账户上下文用简体中文回答。",
      "不要执行任何交易、不要写账户、不要改规则；任何买卖想法只能作为待人工复核的建议输出。",
    ].join("\n"),
    context,
    constraints: {
      locale: "zh-CN",
      timezone: "Asia/Shanghai",
      outputFormat: "json",
      toolPermissions: [],
    },
    createdAt: generatedAt,
  });

  const output = await dependencies.brainProvider.generate(brainInput);
  const auditEvent = buildAskAudit({
    requestId,
    generatedAt,
    account: input.account,
    valuation,
    provider: output.provider,
    pricesAvailable,
  });

  return {
    requestId,
    generatedAt,
    question,
    valuation,
    pricesAvailable,
    answer: output.summary,
    structured: output.structured,
    citations: output.citations,
    confidence: output.confidence,
    provider: output.provider,
    model: output.model,
    auditEvent,
    metadata: {
      ...input.metadata,
      provider: output.provider,
      model: output.model,
      pricesAvailable,
      positionCount: input.positions.length,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  };
}

function buildAskContext(
  valuation: PortfolioValuation,
  pricesAvailable: boolean,
  asOf: string,
): Record<string, JsonValue> {
  return {
    asOf,
    pricesAvailable,
    account: {
      accountId: valuation.accountId,
      availableCash: valuation.cash.available,
      frozenCash: valuation.cash.frozen,
      totalCash: valuation.cash.total,
    },
    totals: {
      totalAssets: valuation.totalAssets,
      totalPositionMarketValue: valuation.totalPositionMarketValue,
      totalCostBasis: valuation.totalCostBasis,
      totalUnrealizedPnl: valuation.totalUnrealizedPnl,
      investedRatio: valuation.investedRatio,
    },
    positions: valuation.positions.map((position) => ({
      symbol: position.symbol,
      market: position.market,
      name: position.name,
      quantity: position.quantity,
      sellableQuantity: position.sellableQuantity,
      costPrice: position.costPrice,
      latestPrice: position.latestPrice,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
      unrealizedPnlRatio: position.unrealizedPnlRatio,
      positionRatio: position.positionRatio,
    })),
  };
}

function buildAskAudit(input: {
  requestId: string;
  generatedAt: string;
  account: Account;
  valuation: PortfolioValuation;
  provider: string;
  pricesAvailable: boolean;
}): AuditEvent {
  return auditEventSchema.parse({
    eventId: `audit-ask-${input.requestId}`.slice(0, 128),
    occurredAt: input.generatedAt,
    actor: { type: "cli", id: "ask-portfolio" },
    action: "read",
    subject: { type: "account", id: input.account.accountId },
    severity: "info",
    result: "success",
    message: `Answered portfolio question for ${input.account.accountId}`,
    correlationId: input.requestId,
    metadata: {
      provider: input.provider,
      pricesAvailable: input.pricesAvailable,
      positionCount: input.valuation.positions.length,
      totalAssets: input.valuation.totalAssets,
      brokerConnected: false,
      directExecutionAllowed: false,
      liveTrading: false,
    },
  });
}

function normalizeNow(now: string | undefined): string {
  if (now === undefined) {
    return new Date().toISOString();
  }

  const parsed = new Date(now);

  if (Number.isNaN(parsed.getTime())) {
    throw new AskPortfolioError(`Invalid timestamp: ${now}`);
  }

  return parsed.toISOString();
}

export class AskPortfolioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskPortfolioError";
  }
}
