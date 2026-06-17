import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../shared/index.js";
import {
  klineBarSchema,
  quoteSnapshotSchema,
  type KlineBar,
  type QuoteSnapshot,
} from "./schemas.js";
import { sortKlineBars } from "./indicators.js";

const RATIO_DECIMALS = 6;

export const volumePriceLabelSchema = z.enum([
  "normal",
  "volume_surge",
  "volume_price_rise",
  "volume_stagnation",
  "low_liquidity",
  "suspended_or_no_volume",
  "insufficient_data",
]);

export const volumePriceLiquiditySchema = z.enum([
  "normal",
  "low",
  "suspended",
  "unknown",
]);

export const volumePriceSignalSchema = z
  .object({
    signalId: identifierSchema,
    symbol: z.string().regex(/^\d{6}$/),
    market: z.enum(["SSE", "SZSE"]),
    name: z.string().trim().min(1).max(80).optional(),
    asOf: z.string().trim().min(1).max(40),
    labels: z.array(volumePriceLabelSchema).min(1),
    liquidity: volumePriceLiquiditySchema,
    latestVolume: z.number().int().nonnegative().optional(),
    averageVolume: z.number().finite().nonnegative().optional(),
    relativeVolume: z.number().finite().nonnegative().optional(),
    priceChangePct: z.number().finite().optional(),
    sampleSize: z.number().int().nonnegative(),
    metadata: z.record(jsonValueSchema).default({}),
  })
  .strict();

export interface VolumePriceSignalOptions {
  averageWindow?: number;
  volumeSurgeRatio?: number;
  priceRiseThreshold?: number;
  stagnationAbsThreshold?: number;
  lowLiquidityVolume?: number;
}

export interface QuoteVolumePriceSignalInput {
  quote: QuoteSnapshot;
  averageVolume?: number;
  previousPrice?: number;
  options?: VolumePriceSignalOptions;
}

export type VolumePriceLabel = z.infer<typeof volumePriceLabelSchema>;
export type VolumePriceLiquidity = z.infer<typeof volumePriceLiquiditySchema>;
export type VolumePriceSignal = z.infer<typeof volumePriceSignalSchema>;

interface NormalizedVolumePriceOptions {
  averageWindow: number;
  volumeSurgeRatio: number;
  priceRiseThreshold: number;
  stagnationAbsThreshold: number;
  lowLiquidityVolume: number;
}

export function calculateKlineVolumePriceSignal(
  barsInput: readonly KlineBar[],
  optionsInput: VolumePriceSignalOptions = {},
): VolumePriceSignal {
  const options = normalizeOptions(optionsInput);

  if (barsInput.length === 0) {
    throw new VolumePriceSignalError("At least one kline bar is required");
  }

  const bars = sortKlineBars(barsInput.map((bar) => klineBarSchema.parse(bar)));
  const latest = bars[bars.length - 1]!;
  const previous = bars.length >= 2 ? bars[bars.length - 2] : undefined;
  const baseline = bars.slice(Math.max(0, bars.length - 1 - options.averageWindow), -1);
  const averageVolume = calculateAverageVolume(baseline);
  const priceChangePct =
    previous && previous.close > 0 ? roundRatio((latest.close - previous.close) / previous.close) : undefined;

  return buildSignal({
    signalId: `volume-kline-${latest.market}-${latest.symbol}-${latest.tradeDate}`,
    symbol: latest.symbol,
    market: latest.market,
    asOf: latest.tradeDate,
    latestVolume: latest.volume,
    averageVolume,
    priceChangePct,
    sampleSize: bars.length,
    suspended: latest.volume === 0,
    options,
    metadata: {
      source: "kline",
      period: latest.period,
      rawSymbol: latest.rawSymbol,
      brokerConnected: false,
      liveTrading: false,
    },
  });
}

export function calculateQuoteVolumePriceSignal(
  input: QuoteVolumePriceSignalInput,
): VolumePriceSignal {
  const quote = quoteSnapshotSchema.parse(input.quote);
  const options = normalizeOptions(input.options);
  const priceChangePct =
    input.previousPrice !== undefined && input.previousPrice > 0
      ? roundRatio((quote.latestPrice - input.previousPrice) / input.previousPrice)
      : quote.changePct;

  return buildSignal({
    signalId: `volume-quote-${quote.market}-${quote.symbol}-${quote.receivedAt.replace(/\D/g, "")}`,
    symbol: quote.symbol,
    market: quote.market,
    name: quote.name,
    asOf: quote.receivedAt,
    latestVolume: quote.volume,
    averageVolume: input.averageVolume,
    priceChangePct,
    sampleSize: input.averageVolume === undefined ? 1 : 2,
    suspended: quote.volume === 0 || quote.latestPrice === 0,
    options,
    metadata: {
      source: "quote",
      rawSymbol: quote.rawSymbol,
      brokerConnected: false,
      liveTrading: false,
    },
  });
}

function buildSignal(input: {
  signalId: string;
  symbol: string;
  market: "SSE" | "SZSE";
  name?: string;
  asOf: string;
  latestVolume?: number;
  averageVolume?: number;
  priceChangePct?: number;
  sampleSize: number;
  suspended: boolean;
  options: NormalizedVolumePriceOptions;
  metadata: Record<string, unknown>;
}): VolumePriceSignal {
  const relativeVolume =
    input.latestVolume !== undefined && input.averageVolume !== undefined && input.averageVolume > 0
      ? roundRatio(input.latestVolume / input.averageVolume)
      : undefined;
  const labels = classifyLabels({
    latestVolume: input.latestVolume,
    averageVolume: input.averageVolume,
    relativeVolume,
    priceChangePct: input.priceChangePct,
    suspended: input.suspended,
    options: input.options,
  });
  const liquidity = classifyLiquidity(input.latestVolume, input.options, input.suspended);

  return volumePriceSignalSchema.parse({
    signalId: safeIdentifier(input.signalId),
    symbol: input.symbol,
    market: input.market,
    name: input.name,
    asOf: input.asOf,
    labels,
    liquidity,
    latestVolume: input.latestVolume,
    averageVolume: input.averageVolume,
    relativeVolume,
    priceChangePct: input.priceChangePct,
    sampleSize: input.sampleSize,
    metadata: input.metadata,
  });
}

function classifyLabels(input: {
  latestVolume?: number;
  averageVolume?: number;
  relativeVolume?: number;
  priceChangePct?: number;
  suspended: boolean;
  options: NormalizedVolumePriceOptions;
}): VolumePriceLabel[] {
  if (input.suspended) {
    return ["suspended_or_no_volume"];
  }

  if (input.latestVolume === undefined || input.averageVolume === undefined || input.relativeVolume === undefined) {
    return ["insufficient_data"];
  }

  const labels: VolumePriceLabel[] = [];

  if (
    input.latestVolume < input.options.lowLiquidityVolume ||
    input.averageVolume < input.options.lowLiquidityVolume
  ) {
    labels.push("low_liquidity");
  }

  if (input.relativeVolume >= input.options.volumeSurgeRatio) {
    if (input.priceChangePct !== undefined && input.priceChangePct >= input.options.priceRiseThreshold) {
      labels.push("volume_price_rise");
    } else if (
      input.priceChangePct !== undefined &&
      Math.abs(input.priceChangePct) <= input.options.stagnationAbsThreshold
    ) {
      labels.push("volume_stagnation");
    } else {
      labels.push("volume_surge");
    }
  }

  return labels.length > 0 ? labels : ["normal"];
}

function classifyLiquidity(
  latestVolume: number | undefined,
  options: NormalizedVolumePriceOptions,
  suspended: boolean,
): VolumePriceLiquidity {
  if (suspended) {
    return "suspended";
  }

  if (latestVolume === undefined) {
    return "unknown";
  }

  return latestVolume < options.lowLiquidityVolume ? "low" : "normal";
}

function calculateAverageVolume(bars: readonly KlineBar[]): number | undefined {
  if (bars.length === 0) {
    return undefined;
  }

  return roundRatio(bars.reduce((sum, bar) => sum + bar.volume, 0) / bars.length);
}

function normalizeOptions(
  options: VolumePriceSignalOptions = {},
): NormalizedVolumePriceOptions {
  const normalized = {
    averageWindow: options.averageWindow ?? 20,
    volumeSurgeRatio: options.volumeSurgeRatio ?? 2,
    priceRiseThreshold: options.priceRiseThreshold ?? 0.02,
    stagnationAbsThreshold: options.stagnationAbsThreshold ?? 0.005,
    lowLiquidityVolume: options.lowLiquidityVolume ?? 10_000,
  };

  if (!Number.isInteger(normalized.averageWindow) || normalized.averageWindow <= 0 || normalized.averageWindow > 120) {
    throw new VolumePriceSignalError("averageWindow must be an integer between 1 and 120");
  }

  assertNonNegative(normalized.volumeSurgeRatio, "volumeSurgeRatio");
  assertNonNegative(normalized.priceRiseThreshold, "priceRiseThreshold");
  assertNonNegative(normalized.stagnationAbsThreshold, "stagnationAbsThreshold");
  assertNonNegative(normalized.lowLiquidityVolume, "lowLiquidityVolume");

  return normalized;
}

function assertNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new VolumePriceSignalError(`${name} must be a non-negative number`);
  }
}

function roundRatio(value: number): number {
  const factor = 10 ** RATIO_DECIMALS;
  const epsilon = Number.EPSILON * Math.sign(value || 1);
  return Math.round((value + epsilon) * factor) / factor;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "volume-price-signal";
}

export class VolumePriceSignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumePriceSignalError";
  }
}
