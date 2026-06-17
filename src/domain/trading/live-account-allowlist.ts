import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
} from "../shared/index.js";

export const liveTradingModeSchema = z.enum(["paper", "manual", "live"]);
export const liveBrokerProviderSchema = z.enum([
  "paper",
  "manual_confirm",
  "fake_live",
  "qmt",
  "ptrade",
]);
export const liveAccountAllowlistEntryStatusSchema = z.enum(["enabled", "disabled"]);

export const liveAccountAllowlistEntrySchema = z
  .object({
    accountId: identifierSchema,
    brokerProvider: liveBrokerProviderSchema,
    tradingMode: z.literal("live"),
    status: liveAccountAllowlistEntryStatusSchema.default("enabled"),
    displayName: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().min(1).max(500),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema.optional(),
    metadata: jsonValueSchema.default({}),
  })
  .strict()
  .superRefine((entry, context) => {
    if (isWildcardAccountId(entry.accountId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accountId"],
        message: "accountId must not be a wildcard",
      });
    }

    if (Date.parse(entry.updatedAt) < Date.parse(entry.createdAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message: "updatedAt must be greater than or equal to createdAt",
      });
    }
  });

export const liveAccountAllowlistSchema = z
  .object({
    allowlistId: identifierSchema.default("live-account-allowlist"),
    updatedAt: isoDateTimeSchema,
    entries: z.array(liveAccountAllowlistEntrySchema),
    metadata: jsonValueSchema.default({}),
  })
  .strict()
  .superRefine((allowlist, context) => {
    const seen = new Set<string>();

    for (const [index, entry] of allowlist.entries.entries()) {
      const key = `${entry.brokerProvider}:${entry.accountId}`;

      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "accountId"],
          message: `Duplicate allowlist entry for ${key}`,
        });
      }

      seen.add(key);
    }
  });

export type LiveTradingMode = z.infer<typeof liveTradingModeSchema>;
export type LiveBrokerProvider = z.infer<typeof liveBrokerProviderSchema>;
export type LiveAccountAllowlistEntryStatus = z.infer<
  typeof liveAccountAllowlistEntryStatusSchema
>;
export type LiveAccountAllowlistEntry = z.infer<typeof liveAccountAllowlistEntrySchema>;
export type LiveAccountAllowlist = z.infer<typeof liveAccountAllowlistSchema>;

export interface FindLiveAccountAllowlistEntryInput {
  allowlist?: LiveAccountAllowlist;
  accountId: string;
  brokerProvider: LiveBrokerProvider;
  now: Date;
}

export function isLiveBrokerProvider(provider: LiveBrokerProvider): boolean {
  return provider === "fake_live" || provider === "qmt" || provider === "ptrade";
}

export function findLiveAccountAllowlistEntry(
  input: FindLiveAccountAllowlistEntryInput,
): LiveAccountAllowlistEntry | undefined {
  const allowlist = input.allowlist
    ? liveAccountAllowlistSchema.parse(input.allowlist)
    : undefined;

  if (!allowlist) {
    return undefined;
  }

  const candidate = allowlist.entries.find(
    (entry) =>
      entry.accountId === input.accountId &&
      entry.brokerProvider === input.brokerProvider &&
      entry.tradingMode === "live",
  );

  if (!candidate || candidate.status !== "enabled") {
    return undefined;
  }

  if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= input.now.getTime()) {
    return undefined;
  }

  return candidate;
}

export function maskAccountId(accountId: string): string {
  const normalized = accountId.trim();

  if (normalized.length <= 4) {
    return "***";
  }

  if (normalized.length <= 8) {
    return `${normalized.slice(0, 1)}***${normalized.slice(-1)}`;
  }

  return `${normalized.slice(0, 3)}***${normalized.slice(-4)}`;
}

function isWildcardAccountId(accountId: string): boolean {
  return /^(all|any|\*)$/i.test(accountId.trim());
}
