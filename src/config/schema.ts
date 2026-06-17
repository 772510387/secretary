import { z } from "zod";

export const DEFAULT_DASHSCOPE_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";

const nonEmptyString = z.string().trim().min(1);
const optionalSecret = z.string().trim().optional();

export const runtimeConfigSchema = z
  .object({
    nodeEnv: z.enum(["development", "test", "production"]).default("development"),
    timezone: nonEmptyString.default("Asia/Shanghai"),
    liveTrading: z.boolean().default(false),
  })
  .strict();

export const storageConfigSchema = z
  .object({
    dataDir: nonEmptyString.default("./data"),
    memoryDir: nonEmptyString.default("./memory"),
  })
  .strict();

export const marketConfigSchema = z
  .object({
    provider: z.enum(["tencent", "mock"]).default("tencent"),
    sentinelIntervalMs: z.number().int().min(1000).default(3000),
    quoteTimeoutMs: z.number().int().min(1000).default(5000),
    tushareToken: optionalSecret,
  })
  .strict();

export const tradingConfigSchema = z
  .object({
    mode: z.enum(["paper", "manual", "live"]).default("paper"),
    initialCash: z.number().finite().positive().default(20000),
    mainBoardOnly: z.boolean().default(true),
    lotSize: z.number().int().positive().default(100),
    t1Enabled: z.boolean().default(true),
  })
  .strict();

export const brokerConfigSchema = z
  .object({
    provider: z.enum(["paper", "manual", "readonly", "qmt", "ptrade"]).default("paper"),
    accountId: z.string().trim().optional(),
  })
  .strict();

export const riskConfigSchema = z
  .object({
    maxSinglePositionRatio: z.number().min(0).max(1).default(0.4),
    hardStopLossRatio: z.number().min(0).max(1).default(0.08),
    dailyLossLimitRatio: z.number().min(0).max(1).default(0.03),
    maxDailyOrderCount: z.number().int().positive().default(20),
  })
  .strict();

const openAiProviderConfigSchema = z
  .object({
    apiKey: optionalSecret,
    model: z.string().trim().optional(),
  })
  .strict();

const geminiProviderConfigSchema = z
  .object({
    apiKey: optionalSecret,
    model: z.string().trim().optional(),
  })
  .strict();

const dashScopeProviderConfigSchema = z
  .object({
    apiKey: optionalSecret,
    baseUrl: z.string().url().default(DEFAULT_DASHSCOPE_BASE_URL),
    model: z.string().trim().optional(),
  })
  .strict();

export const brainConfigSchema = z
  .object({
    provider: z.enum(["mock", "openai", "gemini", "dashscope"]).default("mock"),
    fallbackProvider: z.enum(["mock", "openai", "gemini", "dashscope"]).optional(),
    temperature: z.number().min(0).max(2).default(0.2),
    structuredOutput: z.boolean().default(true),
    openai: openAiProviderConfigSchema.default({}),
    gemini: geminiProviderConfigSchema.default({}),
    dashscope: dashScopeProviderConfigSchema.default({}),
  })
  .strict();

export const searchConfigSchema = z
  .object({
    provider: z.enum(["none", "tavily"]).default("none"),
    tavilyApiKey: optionalSecret,
    maxResults: z.number().int().positive().max(20).default(5),
  })
  .strict();

export const notificationConfigSchema = z
  .object({
    defaultCooldownSeconds: z.number().int().nonnegative().default(600),
    criticalCooldownSeconds: z.number().int().nonnegative().default(60),
    wecomBotWebhookUrl: optionalSecret,
    wecomNotify: z.boolean().default(false),
    wecomHeartbeatMs: z.number().int().positive().optional(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    runtime: runtimeConfigSchema.default({}),
    storage: storageConfigSchema.default({}),
    market: marketConfigSchema.default({}),
    trading: tradingConfigSchema.default({}),
    broker: brokerConfigSchema.default({}),
    risk: riskConfigSchema.default({}),
    brain: brainConfigSchema.default({}),
    notification: notificationConfigSchema.default({}),
    search: searchConfigSchema.default({}),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export type BrainProviderName = AppConfig["brain"]["provider"];
export type BrokerProviderName = AppConfig["broker"]["provider"];
export type MarketProviderName = AppConfig["market"]["provider"];

