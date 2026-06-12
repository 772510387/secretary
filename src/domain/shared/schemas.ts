import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const isoDateTimeSchema = z.string().datetime();

export const tradeDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const currencySchema = z.enum(["CNY", "HKD", "USD"]);

export const stockMarketSchema = z.enum(["SSE", "SZSE"]);

export const stockSymbolSchema = z
  .string()
  .regex(/^\d{6}$/, "Expected a 6-digit A-share symbol");

export const nonNegativeMoneySchema = z.number().finite().nonnegative();

export const positiveMoneySchema = z.number().finite().positive();

export const nonNegativeQuantitySchema = z.number().int().nonnegative();

export const positiveQuantitySchema = z.number().int().positive();

export const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "Invalid identifier");

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

