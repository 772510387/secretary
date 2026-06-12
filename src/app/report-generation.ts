import { z } from "zod";
import {
  brainOutputSchema,
  brainInputSchema,
  type BrainOutput,
  type BrainProvider,
} from "../domain/brain/index.js";
import {
  quoteSnapshotSchema,
  type QuoteSnapshot,
} from "../domain/market/index.js";
import {
  accountSchema,
  positionSchema,
  roundMoney,
  roundRatio,
  type Account,
  type Position,
} from "../domain/portfolio/index.js";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  nonNegativeMoneySchema,
  nonNegativeQuantitySchema,
  tradeDateSchema,
} from "../domain/shared/index.js";

export const reportTypeSchema = z.enum([
  "pre_market_plan",
  "midday_review",
  "closing_review",
  "daily_reflection",
]);

export const reportAccountSummarySchema = z
  .object({
    accountId: identifierSchema,
    accountType: z.enum(["paper", "manual", "live"]),
    status: z.enum(["active", "suspended", "closed"]),
    initialCash: nonNegativeMoneySchema,
    cashAvailable: nonNegativeMoneySchema,
    cashFrozen: nonNegativeMoneySchema,
  })
  .strict();

export const reportPositionSummarySchema = z
  .object({
    positionCount: nonNegativeQuantitySchema,
    totalQuantity: nonNegativeQuantitySchema,
    totalCost: nonNegativeMoneySchema,
    totalMarketValue: nonNegativeMoneySchema,
    unrealizedPnl: z.number().finite(),
    positionRatio: z.number().finite().min(0),
    items: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^\d{6}$/),
            market: z.enum(["SSE", "SZSE"]),
            name: z.string().trim().min(1).max(80),
            quantity: nonNegativeQuantitySchema,
            availableQuantity: nonNegativeQuantitySchema,
            costPrice: nonNegativeMoneySchema,
            latestPrice: nonNegativeMoneySchema.optional(),
            marketValue: nonNegativeMoneySchema,
            unrealizedPnl: z.number().finite(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const reportMarketSummarySchema = z
  .object({
    quoteCount: nonNegativeQuantitySchema,
    quotes: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^\d{6}$/),
            market: z.enum(["SSE", "SZSE"]),
            name: z.string().trim().min(1).max(80),
            latestPrice: nonNegativeMoneySchema,
            changePct: z.number().finite(),
            receivedAt: isoDateTimeSchema,
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const reportRecommendationSchema = z
  .object({
    action: z.enum(["watch", "research", "review", "manual_confirm"]),
    message: z.string().trim().min(1).max(1000),
    source: z.enum(["brain", "system"]),
    executable: z.literal(false).default(false),
  })
  .strict();

export const generatedReportSchema = z
  .object({
    reportId: identifierSchema,
    reportType: reportTypeSchema,
    title: z.string().trim().min(1).max(200),
    tradingDate: tradeDateSchema,
    generatedAt: isoDateTimeSchema,
    accountSummary: reportAccountSummarySchema,
    positionSummary: reportPositionSummarySchema,
    marketSummary: reportMarketSummarySchema,
    riskSummary: z.array(z.string().trim().min(1).max(1000)).default([]),
    facts: z.array(z.string().trim().min(1).max(1000)).default([]),
    inferences: z.array(z.string().trim().min(1).max(1000)).default([]),
    recommendations: z.array(reportRecommendationSchema).default([]),
    brainOutput: brainOutputSchema,
    contentMarkdown: z.string().trim().min(1).max(100_000),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export interface ReportWriteResult {
  filePath: string;
  backupPath?: string;
}

export interface ReportWriter {
  writeReport(report: GeneratedReport): ReportWriteResult;
}

export interface GenerateReportInput {
  reportType: ReportType;
  account: Account;
  positions: Position[];
  quotes: QuoteSnapshot[];
  brainProvider: BrainProvider;
  writer: ReportWriter;
  now?: Date | string;
  tradingDate?: string;
  requestId?: string;
  reportId?: string;
  riskNotes?: string[];
  metadata?: Record<string, unknown>;
}

export interface GenerateReportResult {
  report: GeneratedReport;
  write: ReportWriteResult;
}

export interface GenerateDailyReportsInput extends Omit<GenerateReportInput, "reportType"> {
  reportTypes?: ReportType[];
}

export type ReportType = z.infer<typeof reportTypeSchema>;
export type ReportAccountSummary = z.infer<typeof reportAccountSummarySchema>;
export type ReportPositionSummary = z.infer<typeof reportPositionSummarySchema>;
export type ReportMarketSummary = z.infer<typeof reportMarketSummarySchema>;
export type ReportRecommendation = z.infer<typeof reportRecommendationSchema>;
export type GeneratedReport = z.infer<typeof generatedReportSchema>;

export async function generateReport(input: GenerateReportInput): Promise<GenerateReportResult> {
  const now = normalizeDate(input.now);
  const generatedAt = now.toISOString();
  const tradingDate = input.tradingDate ?? formatTradeDate(now);
  const account = accountSchema.parse(input.account);
  const positions = input.positions.map((position) => positionSchema.parse(position));
  const quotes = input.quotes.map((quote) => quoteSnapshotSchema.parse(quote));
  const accountSummary = summarizeAccount(account);
  const positionSummary = summarizePositions(positions, accountSummary.cashAvailable);
  const marketSummary = summarizeMarket(quotes);
  const requestId = input.requestId ?? `brain-report-${input.reportType}-${tradingDate}`;
  const brainInput = brainInputSchema.parse({
    requestId,
    taskType: input.reportType,
    prompt: buildReportPrompt(input.reportType),
    context: {
      tradingDate,
      accountSummary,
      positionSummary,
      marketSummary,
      riskNotes: input.riskNotes ?? [],
    },
    constraints: {
      outputFormat: "json",
      schemaName: "GeneratedReportBrainStructured",
      toolPermissions: [
        {
          toolName: "portfolio.read",
          visibility: "read_only",
          canExecute: false,
          reason: "Reports may inspect portfolio context but cannot mutate it.",
        },
        {
          toolName: "broker.submitOrder",
          visibility: "hidden",
          canExecute: false,
          reason: "Reports must never execute trades.",
        },
      ],
    },
    createdAt: generatedAt,
  });
  const brainOutput = await input.brainProvider.generate(brainInput, {
    structuredOutputSchema: reportBrainStructuredSchema(input.reportType),
  });
  const report = buildGeneratedReport({
    reportId: input.reportId ?? `report-${input.reportType}-${tradingDate}`,
    reportType: input.reportType,
    title: reportTitle(input.reportType, tradingDate),
    tradingDate,
    generatedAt,
    accountSummary,
    positionSummary,
    marketSummary,
    riskNotes: input.riskNotes ?? [],
    brainOutput,
    metadata: input.metadata ?? {},
  });
  const write = input.writer.writeReport(report);

  return {
    report,
    write,
  };
}

export async function generateDailyReports(
  input: GenerateDailyReportsInput,
): Promise<GenerateReportResult[]> {
  const reportTypes = input.reportTypes ?? reportTypeSchema.options;
  const results: GenerateReportResult[] = [];

  for (const reportType of reportTypes) {
    results.push(
      await generateReport({
        ...input,
        reportType,
      }),
    );
  }

  return results;
}

function reportBrainStructuredSchema(reportType: ReportType): z.ZodType<unknown> {
  return z
    .object({
      taskType: z.literal(reportType),
      keyPoints: z.array(z.string().trim().min(1)).min(1),
      riskWarnings: z.array(z.string().trim().min(1)).default([]),
      nextActions: z.array(z.string().trim().min(1)).default([]),
      stance: z.string().trim().min(1).optional(),
      contextDigest: z.string().trim().min(1).optional(),
    })
    .passthrough();
}

function buildGeneratedReport(input: {
  reportId: string;
  reportType: ReportType;
  title: string;
  tradingDate: string;
  generatedAt: string;
  accountSummary: ReportAccountSummary;
  positionSummary: ReportPositionSummary;
  marketSummary: ReportMarketSummary;
  riskNotes: string[];
  brainOutput: BrainOutput;
  metadata: Record<string, unknown>;
}): GeneratedReport {
  const structured = reportBrainStructuredSchema(input.reportType).parse(
    input.brainOutput.structured,
  ) as {
    keyPoints: string[];
    riskWarnings?: string[];
    nextActions?: string[];
  };
  const riskSummary = uniqueStrings([
    ...input.riskNotes,
    ...(structured.riskWarnings ?? []),
  ]);
  const recommendations = buildRecommendations(structured.nextActions ?? []);
  const facts = buildFacts(input.accountSummary, input.positionSummary, input.marketSummary);
  const inferences = uniqueStrings([input.brainOutput.summary, ...structured.keyPoints]);

  return generatedReportSchema.parse({
    reportId: input.reportId,
    reportType: input.reportType,
    title: input.title,
    tradingDate: input.tradingDate,
    generatedAt: input.generatedAt,
    accountSummary: input.accountSummary,
    positionSummary: input.positionSummary,
    marketSummary: input.marketSummary,
    riskSummary,
    facts,
    inferences,
    recommendations,
    brainOutput: input.brainOutput,
    contentMarkdown: renderReportMarkdown({
      title: input.title,
      generatedAt: input.generatedAt,
      facts,
      inferences,
      riskSummary,
      recommendations,
    }),
    metadata: {
      ...input.metadata,
      liveTrading: false,
      directExecutionAllowed: false,
    },
  });
}

function summarizeAccount(account: Account): ReportAccountSummary {
  return reportAccountSummarySchema.parse({
    accountId: account.accountId,
    accountType: account.type,
    status: account.status,
    initialCash: account.initialCash,
    cashAvailable: account.cash.available,
    cashFrozen: account.cash.frozen,
  });
}

function summarizePositions(
  positions: Position[],
  cashAvailable: number,
): ReportPositionSummary {
  const items = positions.map((position) => {
    const latestPrice = position.latestPrice ?? position.costPrice;
    const marketValue = roundMoney(position.quantity * latestPrice);
    const totalCost = roundMoney(position.quantity * position.costPrice);

    return {
      symbol: position.symbol,
      market: position.market,
      name: position.name,
      quantity: position.quantity,
      availableQuantity: position.availableQuantity,
      costPrice: position.costPrice,
      latestPrice: position.latestPrice,
      marketValue,
      unrealizedPnl: roundMoney(marketValue - totalCost),
    };
  });
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const totalCost = roundMoney(
    positions.reduce((sum, position) => sum + position.quantity * position.costPrice, 0),
  );
  const totalMarketValue = roundMoney(
    items.reduce((sum, item) => sum + item.marketValue, 0),
  );
  const totalAssets = roundMoney(cashAvailable + totalMarketValue);

  return reportPositionSummarySchema.parse({
    positionCount: positions.length,
    totalQuantity,
    totalCost,
    totalMarketValue,
    unrealizedPnl: roundMoney(totalMarketValue - totalCost),
    positionRatio: totalAssets > 0 ? roundRatio(totalMarketValue / totalAssets) : 0,
    items,
  });
}

function summarizeMarket(quotes: QuoteSnapshot[]): ReportMarketSummary {
  return reportMarketSummarySchema.parse({
    quoteCount: quotes.length,
    quotes: quotes.map((quote) => ({
      symbol: quote.symbol,
      market: quote.market,
      name: quote.name,
      latestPrice: quote.latestPrice,
      changePct: quote.changePct,
      receivedAt: quote.receivedAt,
    })),
  });
}

function buildFacts(
  account: ReportAccountSummary,
  positions: ReportPositionSummary,
  market: ReportMarketSummary,
): string[] {
  return [
    `Generated for account ${account.accountId} at cash ${account.cashAvailable}.`,
    `Portfolio has ${positions.positionCount} positions and market value ${positions.totalMarketValue}.`,
    `Market summary contains ${market.quoteCount} quote snapshots.`,
  ];
}

function buildRecommendations(nextActions: string[]): ReportRecommendation[] {
  const actions = nextActions.length > 0
    ? nextActions
    : ["Review the report manually before creating any trade intent draft."];

  return actions.map((message) =>
    reportRecommendationSchema.parse({
      action: "review",
      message,
      source: nextActions.length > 0 ? "brain" : "system",
      executable: false,
    }),
  );
}

function renderReportMarkdown(input: {
  title: string;
  generatedAt: string;
  facts: string[];
  inferences: string[];
  riskSummary: string[];
  recommendations: ReportRecommendation[];
}): string {
  return [
    `# ${input.title}`,
    "",
    `Generated at: ${input.generatedAt}`,
    "",
    "## Facts",
    ...input.facts.map((item) => `- ${item}`),
    "",
    "## Inferences",
    ...input.inferences.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...(input.riskSummary.length > 0
      ? input.riskSummary.map((item) => `- ${item}`)
      : ["- No explicit risk note was provided."]),
    "",
    "## Recommendations",
    ...input.recommendations.map((item) => `- ${item.message}`),
    "",
    "All recommendations are non-executable drafts.",
  ].join("\n");
}

function buildReportPrompt(reportType: ReportType): string {
  switch (reportType) {
    case "pre_market_plan":
      return "Generate a pre-market plan from the provided account, position, market, and risk context.";
    case "midday_review":
      return "Generate a midday review from the provided account, position, market, and risk context.";
    case "closing_review":
      return "Generate a closing review from the provided account, position, market, and risk context.";
    case "daily_reflection":
      return "Generate a daily reflection from the provided account, position, market, and risk context.";
  }
}

function reportTitle(reportType: ReportType, tradingDate: string): string {
  switch (reportType) {
    case "pre_market_plan":
      return `${tradingDate} Pre-market Plan`;
    case "midday_review":
      return `${tradingDate} Midday Review`;
    case "closing_review":
      return `${tradingDate} Closing Review`;
    case "daily_reflection":
      return `${tradingDate} Daily Reflection`;
  }
}

function normalizeDate(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ReportGenerationError("Invalid report generation date");
    }

    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new ReportGenerationError(`Invalid report generation date: ${value}`);
    }

    return parsed;
  }

  return new Date();
}

function formatTradeDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export class ReportGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportGenerationError";
  }
}
