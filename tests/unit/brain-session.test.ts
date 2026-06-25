import { describe, expect, it } from "vitest";
import {
  compactSession,
  createSteeringQueue,
  summarizeMessagesDigest,
  type AgentMessage,
} from "../../src/domain/brain/index.js";

function transcript(n: number): AgentMessage[] {
  const messages: AgentMessage[] = [{ role: "system", content: "系统提示" }];
  for (let i = 0; i < n; i += 1) {
    messages.push({ role: "user", content: `用户消息 ${i}` });
    messages.push({ role: "assistant", content: `助手回复 ${i}` });
  }
  return messages;
}

describe("compactSession", () => {
  it("does not compact a short transcript", async () => {
    const messages = transcript(3); // 7 messages
    const result = await compactSession(messages, { maxMessages: 20 });
    expect(result.compacted).toBe(false);
    expect(result.messages).toHaveLength(7);
  });

  it("keeps the head + a summary + the recent tail when over the limit", async () => {
    const messages = transcript(20); // 41 messages
    const result = await compactSession(messages, { maxMessages: 10, keepHead: 1 });

    expect(result.compacted).toBe(true);
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0]!.content).toBe("系统提示");
    expect(result.messages[1]!.content).toContain("对话已压缩");
    // The very last original message is preserved verbatim in the tail.
    expect(result.messages.at(-1)!.content).toBe("助手回复 19");
    expect(result.droppedCount).toBeGreaterThan(0);
  });

  it("uses a custom summarizer when provided", async () => {
    const messages = transcript(20);
    const result = await compactSession(messages, {
      maxMessages: 8,
      summarize: () => "自定义摘要",
    });
    expect(result.summary).toBe("自定义摘要");
    expect(result.messages[1]!.content).toContain("自定义摘要");
  });
});

describe("summarizeMessagesDigest", () => {
  it("counts roles and lists tool names", () => {
    const digest = summarizeMessagesDigest([
      { role: "user", content: "买茅台" },
      { role: "assistant", content: "" },
      { role: "tool", content: "{}", name: "paper_buy" },
    ]);
    expect(digest).toContain("1 条用户");
    expect(digest).toContain("paper_buy");
  });
});

describe("createSteeringQueue", () => {
  it("buffers and drains FIFO", () => {
    const queue = createSteeringQueue();
    queue.pushNote("第一条");
    queue.push({ role: "user", content: "第二条" });
    expect(queue.size()).toBe(2);

    const drained = queue.drain();
    expect(drained).toHaveLength(2);
    expect(drained[0]!.content).toBe("第一条");
    expect(drained[0]!.role).toBe("system");
    expect(drained[1]!.content).toBe("第二条");
    // Draining empties the buffer.
    expect(queue.size()).toBe(0);
    expect(queue.drain()).toHaveLength(0);
  });

  it("ignores an empty note", () => {
    const queue = createSteeringQueue();
    queue.pushNote("   ");
    expect(queue.size()).toBe(0);
  });
});
