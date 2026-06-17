import { describe, expect, it } from "vitest";
import {
  SearchProviderError,
  TavilySearchProvider,
  type TavilyFetchInit,
  type TavilyFetchResponse,
} from "../../src/infrastructure/providers/index.js";

describe("TavilySearchProvider", () => {
  it("throws when the API key is missing", async () => {
    const provider = new TavilySearchProvider({ apiKey: " ", fetchImpl: okFetch() });
    await expect(provider.search("a股 政策")).rejects.toThrow(/requires an API key/);
  });

  it("throws when the query is empty", async () => {
    const provider = new TavilySearchProvider({ apiKey: "tvly-x", fetchImpl: okFetch() });
    await expect(provider.search("   ")).rejects.toThrow(/must not be empty/);
  });

  it("sends a Bearer-authed POST and parses results", async () => {
    let url = "";
    let init: TavilyFetchInit | undefined;
    const provider = new TavilySearchProvider({
      apiKey: "tvly-secret",
      fetchImpl: async (u, i) => {
        url = u;
        init = i;
        return response({
          ok: true,
          status: 200,
          text: JSON.stringify({
            query: "a股 政策",
            answer: "近期无重大政策。",
            results: [
              { title: "标题A", url: "https://example.com/a", content: "正文A", score: 0.9 },
              { title: "", url: "", content: "无 url 应被丢弃" },
            ],
          }),
        });
      },
    });

    const result = await provider.search("a股 政策", { maxResults: 3 });

    expect(url).toContain("tavily.com");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer tvly-secret" });
    expect(JSON.parse(init?.body ?? "{}")).toMatchObject({ query: "a股 政策", max_results: 3 });
    expect(result.answer).toBe("近期无重大政策。");
    expect(result.results).toEqual([
      { title: "标题A", url: "https://example.com/a", snippet: "正文A", score: 0.9 },
    ]);
  });

  it.each([
    [401, "auth_failed"],
    [403, "auth_failed"],
    [429, "rate_limited"],
    [500, "server_error"],
  ])("maps HTTP %s to a clear error", async (status, code) => {
    const provider = new TavilySearchProvider({
      apiKey: "tvly-x",
      fetchImpl: async () => response({ ok: false, status, text: JSON.stringify({ error: "x" }) }),
    });
    await expect(provider.search("q")).rejects.toThrow(code);
  });

  it("rejects invalid JSON", async () => {
    const provider = new TavilySearchProvider({
      apiKey: "tvly-x",
      fetchImpl: async () => response({ ok: true, status: 200, text: "{" }),
    });
    await expect(provider.search("q")).rejects.toThrow(SearchProviderError);
  });
});

function okFetch() {
  return async () =>
    response({ ok: true, status: 200, text: JSON.stringify({ query: "q", results: [] }) });
}

function response(input: {
  ok: boolean;
  status: number;
  statusText?: string;
  text: string;
}): TavilyFetchResponse {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    text: async () => input.text,
  };
}
