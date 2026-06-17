import { z } from "zod";
import {
  identifierSchema,
  isoDateTimeSchema,
  jsonValueSchema,
  stockMarketSchema,
  stockSymbolSchema,
} from "../shared/index.js";

export const killSwitchModeSchema = z.enum(["clear", "readOnly", "cancelOnly", "disabled"]);
export const killSwitchScopeSchema = z.enum(["global", "account", "symbol"]);
export const killSwitchActionSchema = z.enum(["read_account", "submit_order", "cancel_order"]);

export const killSwitchRuleSchema = z
  .object({
    ruleId: identifierSchema,
    scope: killSwitchScopeSchema,
    mode: killSwitchModeSchema,
    accountId: identifierSchema.optional(),
    symbol: stockSymbolSchema.optional(),
    market: stockMarketSchema.optional(),
    reason: z.string().trim().min(1).max(500),
    updatedAt: isoDateTimeSchema,
    updatedBy: z
      .object({
        type: z.enum(["user", "system"]),
        id: identifierSchema.optional(),
      })
      .strict(),
    expiresAt: isoDateTimeSchema.optional(),
    metadata: jsonValueSchema.default({}),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.scope === "account" && !rule.accountId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accountId"],
        message: "account kill switch requires accountId",
      });
    }

    if (rule.scope === "symbol" && (!rule.symbol || !rule.market)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbol"],
        message: "symbol kill switch requires symbol and market",
      });
    }

    if (rule.scope === "global" && (rule.accountId || rule.symbol || rule.market)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "global kill switch must not include accountId, symbol, or market",
      });
    }
  });

export const killSwitchStateSchema = z
  .object({
    stateId: identifierSchema.default("kill-switch-state"),
    updatedAt: isoDateTimeSchema,
    rules: z.array(killSwitchRuleSchema),
    metadata: jsonValueSchema.default({}),
  })
  .strict();

export type KillSwitchMode = z.infer<typeof killSwitchModeSchema>;
export type KillSwitchScope = z.infer<typeof killSwitchScopeSchema>;
export type KillSwitchAction = z.infer<typeof killSwitchActionSchema>;
export type KillSwitchRule = z.infer<typeof killSwitchRuleSchema>;
export type KillSwitchState = z.infer<typeof killSwitchStateSchema>;

export interface ResolveKillSwitchInput {
  state?: KillSwitchState;
  accountId: string;
  symbol?: string;
  market?: string;
  action: KillSwitchAction;
  now: Date;
}

export interface KillSwitchResolution {
  mode: KillSwitchMode;
  blocking: boolean;
  blockingReason?: string;
  matchedRules: KillSwitchRule[];
  blockingRules: KillSwitchRule[];
}

export function resolveKillSwitch(input: ResolveKillSwitchInput): KillSwitchResolution {
  const state = input.state ? killSwitchStateSchema.parse(input.state) : undefined;

  if (!state) {
    return {
      mode: "clear",
      blocking: false,
      matchedRules: [],
      blockingRules: [],
    };
  }

  const matchedRules = state.rules
    .filter((rule) => rule.mode !== "clear")
    .filter((rule) => !isExpired(rule, input.now))
    .filter((rule) => matchesScope(rule, input));
  const blockingRules = matchedRules.filter((rule) => modeBlocksAction(rule.mode, input.action));
  const strongestRule = [...blockingRules, ...matchedRules].sort(
    (left, right) => modeWeight(right.mode) - modeWeight(left.mode),
  )[0];

  return {
    mode: strongestRule?.mode ?? "clear",
    blocking: blockingRules.length > 0,
    blockingReason: blockingRules[0]?.reason,
    matchedRules,
    blockingRules,
  };
}

export function modeBlocksAction(mode: KillSwitchMode, action: KillSwitchAction): boolean {
  if (mode === "clear") {
    return false;
  }

  if (mode === "disabled" || mode === "readOnly") {
    return action !== "read_account";
  }

  if (mode === "cancelOnly") {
    return action === "submit_order";
  }

  return false;
}

function matchesScope(rule: KillSwitchRule, input: ResolveKillSwitchInput): boolean {
  if (rule.scope === "global") {
    return true;
  }

  if (rule.scope === "account") {
    return rule.accountId === input.accountId;
  }

  return rule.symbol === input.symbol && rule.market === input.market;
}

function isExpired(rule: KillSwitchRule, now: Date): boolean {
  return rule.expiresAt !== undefined && Date.parse(rule.expiresAt) <= now.getTime();
}

function modeWeight(mode: KillSwitchMode): number {
  switch (mode) {
    case "disabled":
      return 3;
    case "readOnly":
      return 2;
    case "cancelOnly":
      return 1;
    case "clear":
      return 0;
  }
}
