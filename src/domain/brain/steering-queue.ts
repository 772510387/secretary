import type { AgentMessage } from "./tool-loop.js";

/**
 * B1 — steering / follow-up queue (borrowed from openclaw's getSteeringMessages).
 *
 * A cooperative seam for the small-brain (cerebellum) to inject a message INTO a
 * running big-brain (agentic loop) turn. The loop drains this before each model step,
 * so a hard red-line the cerebellum detects mid-analysis — e.g. "已触发 8% 止损，已平仓"
 * — reaches the model on its very next turn instead of waiting for the turn to finish.
 *
 * It is deterministic plumbing: the cerebellum decides WHAT to inject and WHEN; the
 * queue only buffers and hands the messages to the loop in FIFO order.
 */
export interface SteeringQueue {
  /** Push a fully-formed transcript message. */
  push(message: AgentMessage): void;
  /** Push a short note (defaults to a system-role interruption). */
  pushNote(text: string, role?: "user" | "system"): void;
  /** Remove and return all buffered messages (FIFO). The loop calls this each step. */
  drain(): AgentMessage[];
  /** How many messages are buffered. */
  size(): number;
}

export function createSteeringQueue(): SteeringQueue {
  const buffer: AgentMessage[] = [];

  return {
    push(message: AgentMessage): void {
      buffer.push(message);
    },
    pushNote(text: string, role: "user" | "system" = "system"): void {
      const trimmed = text.trim();
      if (trimmed === "") {
        return;
      }
      buffer.push({ role, content: trimmed });
    },
    drain(): AgentMessage[] {
      if (buffer.length === 0) {
        return [];
      }
      return buffer.splice(0, buffer.length);
    },
    size(): number {
      return buffer.length;
    },
  };
}
