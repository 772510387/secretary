import { z } from "zod";
import {
  isoDateTimeSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";

export const signalSeveritySchema = z.enum(["info", "watch", "warning", "critical"]);

export const cerebellumEventTypeSchema = z.enum([
  "price_surge",
  "price_drop",
  "position_stop_loss",
]);

export const cerebellumEventSchema = z
  .object({
    eventId: z.string().trim().min(1),
    eventType: cerebellumEventTypeSchema,
    severity: signalSeveritySchema,
    symbol: stockSymbolSchema,
    market: stockMarketSchema,
    name: z.string().trim().min(1).max(80),
    occurredAt: isoDateTimeSchema,
    message: z.string().trim().min(1).max(1000),
    source: z.literal("market_sentinel"),
    wakeBrain: z.boolean(),
    cooldownKey: z.string().trim().min(1),
    currentPrice: z.number().finite().nonnegative(),
    previousPrice: z.number().finite().nonnegative().optional(),
    changePct: z.number().finite().optional(),
    threshold: z.number().finite().nonnegative(),
  })
  .strict();

export type SignalSeverity = z.infer<typeof signalSeveritySchema>;
export type CerebellumEventType = z.infer<typeof cerebellumEventTypeSchema>;
export type CerebellumEvent = z.infer<typeof cerebellumEventSchema>;

