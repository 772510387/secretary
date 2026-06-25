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
    /** Per-request (total) timeout for the non-streaming path. */
    timeoutMs: z.number().int().min(1000).default(60_000),
    /**
     * Stream the model response (SSE) so a long answer doesn't die at the total
     * timeout; liveness is bounded by idleTimeoutMs instead. Set false to force the
     * single-shot non-streaming call.
     */
    streaming: z.boolean().default(true),
    /**
     * Idle (keepalive) timeout for the streaming path: abort only if NO chunk arrives
     * within this window. A steadily-producing model completes regardless of total
     * length; a stalled one is still cut off.
     */
    idleTimeoutMs: z.number().int().min(1000).default(30_000),
    /** Optional output cap; bounds runaway/huge generations (and surfaces truncation). */
    maxTokens: z.number().int().positive().max(32_000).optional(),
    openai: openAiProviderConfigSchema.default({}),
    gemini: geminiProviderConfigSchema.default({}),
    dashscope: dashScopeProviderConfigSchema.default({}),
  })
  .strict();

export const wechatConfigSchema = z
  .object({
    /** Contact ids/names allowed to command the bot. Empty = read-only for everyone. */
    allowedUsers: z.array(z.string().trim().min(1)).default([]),
    /** wechaty puppet module, e.g. wechaty-puppet-wcferry / wechaty-puppet-padlocal. */
    puppet: z.string().trim().min(1).optional(),
    puppetToken: optionalSecret,
  })
  .strict();

export const feishuConfigSchema = z
  .object({
    appId: z.string().trim().min(1).optional(),
    appSecret: optionalSecret,
    /** Feishu open_ids allowed to run destructive ops. Empty = read-only for everyone. */
    allowedUsers: z.array(z.string().trim().min(1)).default([]),
    /** Opt-in: push alarm/sentinel notifications proactively into Feishu. */
    notify: z.boolean().default(false),
    /** open_ids that receive proactive pushes. Empty → falls back to allowedUsers. */
    pushUsers: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export const searchConfigSchema = z
  .object({
    provider: z.enum(["none", "tavily"]).default("none"),
    tavilyApiKey: optionalSecret,
    maxResults: z.number().int().positive().max(20).default(5),
  })
  .strict();

export const researchConfigSchema = z
  .object({
    /** "mock" = local placeholder; "trading_agents_cn" = real multi-agent subprocess. */
    provider: z.enum(["mock", "trading_agents_cn"]).default("mock"),
    /** Interpreter/command for the bridge (e.g. the TradingAgents-CN venv python). */
    command: z.string().trim().min(1).optional(),
    /** Path to the bridge script (secretary_bridge.py). */
    scriptPath: z.string().trim().min(1).optional(),
    /** Working dir for the subprocess (the TradingAgents-CN repo root). */
    cwd: z.string().trim().min(1).optional(),
    /** Deep research is slow (multi-agent); default 10 min. */
    timeoutMs: z.number().int().min(1000).default(600_000),
    /** DashScope models for the agent team. */
    deepModel: z.string().trim().min(1).default("qwen-plus"),
    quickModel: z.string().trim().min(1).default("qwen-turbo"),
    analysts: z.string().trim().min(1).default("market,fundamentals,news"),
  })
  .strict();

export const budgetConfigSchema = z
  .object({
    /** Max brain analysis calls per Beijing day across the daemons. Empty = unlimited. */
    brainDailyLimit: z.number().int().positive().optional(),
    /** Max deep-research (TradingAgents-CN) runs per day. */
    researchDailyLimit: z.number().int().positive().optional(),
    /** Max web searches per day. */
    searchDailyLimit: z.number().int().positive().optional(),
  })
  .strict();

export const notificationConfigSchema = z
  .object({
    defaultCooldownSeconds: z.number().int().nonnegative().default(600),
    criticalCooldownSeconds: z.number().int().nonnegative().default(60),
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
    research: researchConfigSchema.default({}),
    budget: budgetConfigSchema.default({}),
    wechat: wechatConfigSchema.default({}),
    feishu: feishuConfigSchema.default({}),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

export type BrainProviderName = AppConfig["brain"]["provider"];
export type BrokerProviderName = AppConfig["broker"]["provider"];
export type MarketProviderName = AppConfig["market"]["provider"];

