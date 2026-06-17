import { describe, expect, it } from "vitest";
import {
  BrainProviderError,
  DashScopeQwenProvider,
  FallbackBrainProvider,
  GeminiProvider,
  MockBrainProvider,
  OpenAIProvider,
  createBrainProvider,
  toChatCompletionsEndpoint,
  type BrainConfig,
} from "../../src/infrastructure/providers/index.js";

function makeBrainConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
  return {
    provider: "mock",
    fallbackProvider: undefined,
    temperature: 0.2,
    structuredOutput: true,
    openai: { apiKey: undefined, model: undefined },
    gemini: { apiKey: undefined, model: undefined },
    dashscope: {
      apiKey: undefined,
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: undefined,
    },
    ...overrides,
  };
}

describe("createBrainProvider", () => {
  it("returns a MockBrainProvider for the mock provider", () => {
    const provider = createBrainProvider(makeBrainConfig({ provider: "mock" }));

    expect(provider).toBeInstanceOf(MockBrainProvider);
    expect(provider.providerName).toBe("mock");
  });

  it("returns a DashScopeQwenProvider when a key is configured", () => {
    const provider = createBrainProvider(
      makeBrainConfig({
        provider: "dashscope",
        dashscope: {
          apiKey: "test-key",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen-plus",
        },
      }),
    );

    expect(provider).toBeInstanceOf(DashScopeQwenProvider);
    expect(provider.providerName).toBe("dashscope");
  });

  it("returns an OpenAIProvider when a key is configured", () => {
    const provider = createBrainProvider(
      makeBrainConfig({
        provider: "openai",
        openai: { apiKey: "test-key", model: "gpt-5.5" },
      }),
    );

    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider.providerName).toBe("openai");
  });

  it("fails fast when a real provider has no API key", () => {
    expect(() =>
      createBrainProvider(makeBrainConfig({ provider: "dashscope" })),
    ).toThrow(BrainProviderError);
  });

  it("defers the key check when requireApiKey is false", () => {
    const provider = createBrainProvider(
      makeBrainConfig({ provider: "dashscope" }),
      { requireApiKey: false },
    );

    expect(provider).toBeInstanceOf(DashScopeQwenProvider);
  });

  it("returns a GeminiProvider when a key is configured", () => {
    const provider = createBrainProvider(
      makeBrainConfig({
        provider: "gemini",
        gemini: { apiKey: "test-key", model: "gemini-2.0-flash" },
      }),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
    expect(provider.providerName).toBe("gemini");
  });

  it("wraps primary + fallback in a FallbackBrainProvider", () => {
    const provider = createBrainProvider(
      makeBrainConfig({
        provider: "gemini",
        fallbackProvider: "dashscope",
        gemini: { apiKey: "gemini-key", model: "gemini-2.0-flash" },
        dashscope: {
          apiKey: "dashscope-key",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen-plus",
        },
      }),
    );

    expect(provider).toBeInstanceOf(FallbackBrainProvider);
    // Reports the primary's name; the actual success is reflected in output.provider.
    expect(provider.providerName).toBe("gemini");
  });

  it("does not wrap when fallback equals the primary provider", () => {
    const provider = createBrainProvider(
      makeBrainConfig({
        provider: "gemini",
        fallbackProvider: "gemini",
        gemini: { apiKey: "gemini-key", model: "gemini-2.0-flash" },
      }),
    );

    expect(provider).toBeInstanceOf(GeminiProvider);
  });

  it("fails fast when the fallback provider has no API key", () => {
    expect(() =>
      createBrainProvider(
        makeBrainConfig({
          provider: "gemini",
          fallbackProvider: "dashscope",
          gemini: { apiKey: "gemini-key", model: "gemini-2.0-flash" },
        }),
      ),
    ).toThrow(BrainProviderError);
  });
});

describe("toChatCompletionsEndpoint", () => {
  it("appends the chat/completions path to a compatible-mode base url", () => {
    expect(
      toChatCompletionsEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
    ).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  it("trims trailing slashes before appending", () => {
    expect(toChatCompletionsEndpoint("https://example.com/v1/")).toBe(
      "https://example.com/v1/chat/completions",
    );
  });

  it("leaves an already-complete endpoint untouched", () => {
    expect(
      toChatCompletionsEndpoint("https://example.com/v1/chat/completions"),
    ).toBe("https://example.com/v1/chat/completions");
  });
});
