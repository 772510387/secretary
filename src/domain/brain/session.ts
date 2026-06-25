import type { AgentMessage } from "./tool-loop.js";

/**
 * B2 — session compaction (borrowed from openclaw's buildSessionContext + compaction).
 *
 * Keeps a long brain conversation under control without blowing the context window:
 * the head (system prompt) and the most recent tail are kept verbatim, and the dropped
 * middle is replaced by ONE summary message. The structural part — what to keep, what
 * to drop, where the summary goes — is fully deterministic code. Only the optional
 * `summarize` hook (condensing the dropped span into prose) is model territory; the
 * default summarizer is a deterministic digest so this works with zero model calls.
 */
export interface CompactSessionOptions {
  /** Compact only when the transcript exceeds this many messages. Default 20. */
  maxMessages?: number;
  /** How many leading messages to always keep verbatim (the system prompt). Default 1. */
  keepHead?: number;
  /** Optional model-backed condenser for the dropped span. Defaults to a deterministic digest. */
  summarize?: (dropped: AgentMessage[]) => string | Promise<string>;
}

export interface CompactSessionResult {
  messages: AgentMessage[];
  compacted: boolean;
  droppedCount: number;
  summary?: string;
}

export async function compactSession(
  messages: AgentMessage[],
  options: CompactSessionOptions = {},
): Promise<CompactSessionResult> {
  const maxMessages = options.maxMessages ?? 20;
  const keepHead = Math.max(0, options.keepHead ?? 1);

  if (messages.length <= maxMessages || messages.length <= keepHead + 2) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  // Reserve one slot for the summary message; keep head + the most recent tail.
  const tailCount = Math.max(1, maxMessages - keepHead - 1);
  const head = messages.slice(0, keepHead);
  const dropped = messages.slice(keepHead, messages.length - tailCount);
  const tail = messages.slice(messages.length - tailCount);

  if (dropped.length === 0) {
    return { messages, compacted: false, droppedCount: 0 };
  }

  const summary = options.summarize
    ? (await options.summarize(dropped)).trim()
    : summarizeMessagesDigest(dropped);

  const summaryMessage: AgentMessage = {
    role: "system",
    content: `【对话已压缩：省略 ${dropped.length} 条历史】${summary}`,
  };

  return {
    messages: [...head, summaryMessage, ...tail],
    compacted: true,
    droppedCount: dropped.length,
    summary,
  };
}

/** Deterministic, model-free digest of a dropped message span. */
export function summarizeMessagesDigest(dropped: AgentMessage[]): string {
  let user = 0;
  let assistant = 0;
  let tool = 0;
  const toolNames = new Set<string>();

  for (const message of dropped) {
    if (message.role === "user") {
      user += 1;
    } else if (message.role === "assistant") {
      assistant += 1;
    } else if (message.role === "tool") {
      tool += 1;
      if (message.name) {
        toolNames.add(message.name);
      }
    }
  }

  const toolPart = toolNames.size > 0 ? `；调用过工具：${[...toolNames].join("、")}` : "";
  const lastUser = [...dropped].reverse().find((message) => message.role === "user");
  const lastUserPart = lastUser ? `；最近一条用户消息片段：「${clip(lastUser.content, 80)}」` : "";

  return `含 ${user} 条用户/${assistant} 条助手/${tool} 条工具消息${toolPart}${lastUserPart}`;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
