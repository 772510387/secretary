import type { JsonValue } from "../shared/index.js";
import type { BrainStreamProgress } from "./provider.js";

/**
 * Generic, provider-agnostic agentic tool loop (borrowed from openclaw's two-level
 * agent loop, kept deterministic).
 *
 * The brain (LLM) decides WHAT to do by calling tools; the loop here is pure code:
 * it calls the model, executes whatever tools the model asked for, feeds the results
 * back, and repeats until the model stops calling tools (or a hard iteration cap is
 * hit). The loop never decides strategy — it only drives the turn deterministically.
 *
 * This is the seam where read tools (the "eye": quotes/technicals/portfolio) and
 * write tools (the "hand": paper buy/sell) are exposed. Because the whole trading
 * surface is a database-simulated paper account (no real broker), write tools are
 * allowed: the model boldly decides, the deterministic hand validates+fills, and the
 * caller pushes one "操作+逻辑" notification afterwards.
 */

/** One tool the model may call. `parameters` is a JSON-Schema object. */
export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: JsonValue;
}

/** A tool call the model emitted. `arguments` is the raw JSON string from the model. */
export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** A chat message in the loop transcript, shaped to map 1:1 onto OpenAI chat roles. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Only on assistant messages that requested tools. */
  toolCalls?: AgentToolCall[];
  /** Only on tool messages: the id of the call this answers. */
  toolCallId?: string;
  /** Optional tool name (tool messages) — purely informational. */
  name?: string;
}

/** A single model step: its assistant text plus any tool calls it wants run. */
export interface AgentToolStep {
  content: string;
  toolCalls: AgentToolCall[];
  finishReason?: string;
}

export interface ChatWithToolsRequest {
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onProgress?: (progress: BrainStreamProgress) => void;
  /** Defaults to "auto"; "none" forces a final answer with no tools. */
  toolChoice?: "auto" | "none";
}

/** A brain provider that can do OpenAI-style function calling. */
export interface ToolCallingProvider {
  readonly providerName: string;
  chatWithTools(request: ChatWithToolsRequest): Promise<AgentToolStep>;
}

/**
 * Narrows any value to a ToolCallingProvider when it exposes `chatWithTools`, else
 * undefined. Lets a caller opt into the agentic path only when the configured provider
 * actually supports tools (DashScope / a fallback chain with one), and fall back to the
 * read-only ask otherwise.
 */
export function asToolCallingProvider(value: unknown): ToolCallingProvider | undefined {
  return value !== null &&
    typeof value === "object" &&
    typeof (value as { chatWithTools?: unknown }).chatWithTools === "function" &&
    typeof (value as { providerName?: unknown }).providerName === "string"
    ? (value as ToolCallingProvider)
    : undefined;
}

/** A structured record of what a write tool actually DID (for the operation notification). */
export interface AgentToolEffect {
  /** e.g. "paper_buy", "paper_sell". */
  kind: string;
  /** Whether the simulated account actually changed (a fill) vs. a no-op/blocked. */
  mutated: boolean;
  /** One human-readable line: 操作 + 结果. */
  summary: string;
  data?: JsonValue;
}

export interface AgentToolResult {
  /** JSON string fed back to the model as the tool message content. */
  content: string;
  isError?: boolean;
  /** Present when the tool changed (or attempted to change) account state. */
  effect?: AgentToolEffect;
}

export type AgentToolExecutor = (call: AgentToolCall) => Promise<AgentToolResult>;

export type AgentLoopStoppedReason = "completed" | "max_iterations" | "aborted";

export interface AgentLoopEvent {
  type: "assistant_step" | "tool_result" | "steering" | "final";
  iteration: number;
  message?: AgentMessage;
  effect?: AgentToolEffect;
}

export interface RunAgentToolLoopInput {
  provider: ToolCallingProvider;
  /** Initial transcript — usually [system, user]. Copied; not mutated in place. */
  messages: AgentMessage[];
  tools: AgentToolSpec[];
  execute: AgentToolExecutor;
  /** Hard cap on model round-trips. Default 8. The loop never runs unbounded. */
  maxIterations?: number;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  onProgress?: (progress: BrainStreamProgress) => void;
  /** Observability/persistence hook (B2 session store subscribes here). */
  onEvent?: (event: AgentLoopEvent) => void;
  /**
   * B1 steering: drained BEFORE each model step. Any messages returned (e.g. a
   * cerebellum red-line "已触发8%止损，已平仓") are appended so the model reacts to
   * them on its next turn. Lets the small-brain interrupt/steer the big-brain mid-loop.
   */
  drainSteering?: () => AgentMessage[] | Promise<AgentMessage[]>;
}

export interface RunAgentToolLoopResult {
  answer: string;
  messages: AgentMessage[];
  /** Every write-tool effect, in execution order (drives the operation notification). */
  effects: AgentToolEffect[];
  iterations: number;
  stoppedReason: AgentLoopStoppedReason;
}

const DEFAULT_MAX_ITERATIONS = 8;

export class AgentToolLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentToolLoopError";
  }
}

/**
 * Drives the model→tools→model loop until the model returns a final answer (no tool
 * calls) or the iteration cap is hit. Tool calls within one step run sequentially so
 * paper writes can't race each other. A tool that throws is reported back to the model
 * as an error tool message (cooperative recovery) rather than aborting the whole turn.
 */
export async function runAgentToolLoop(
  input: RunAgentToolLoopInput,
): Promise<RunAgentToolLoopResult> {
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  if (maxIterations < 1) {
    throw new AgentToolLoopError("maxIterations must be >= 1");
  }

  const messages: AgentMessage[] = input.messages.map((message) => ({ ...message }));
  const effects: AgentToolEffect[] = [];
  let iterations = 0;

  for (let i = 0; i < maxIterations; i += 1) {
    if (input.signal?.aborted) {
      return finish(messages, effects, iterations, "aborted");
    }

    await applySteering(input, messages);

    iterations += 1;
    const step = await input.provider.chatWithTools({
      messages,
      tools: input.tools,
      signal: input.signal,
      idleTimeoutMs: input.idleTimeoutMs,
      onProgress: input.onProgress,
    });

    const assistantMessage: AgentMessage = {
      role: "assistant",
      content: step.content,
      ...(step.toolCalls.length > 0 ? { toolCalls: step.toolCalls } : {}),
    };
    messages.push(assistantMessage);
    input.onEvent?.({ type: "assistant_step", iteration: iterations, message: assistantMessage });

    if (step.toolCalls.length === 0) {
      input.onEvent?.({ type: "final", iteration: iterations, message: assistantMessage });
      return finish(messages, effects, iterations, "completed");
    }

    for (const call of step.toolCalls) {
      const result = await executeOne(input.execute, call);
      const toolMessage: AgentMessage = {
        role: "tool",
        content: result.content,
        toolCallId: call.id,
        name: call.name,
      };
      messages.push(toolMessage);
      if (result.effect) {
        effects.push(result.effect);
      }
      input.onEvent?.({
        type: "tool_result",
        iteration: iterations,
        message: toolMessage,
        ...(result.effect ? { effect: result.effect } : {}),
      });
    }
  }

  // Cap reached while the model still wanted tools — ask once more for a plain answer.
  return finish(messages, effects, iterations, "max_iterations");
}

async function applySteering(input: RunAgentToolLoopInput, messages: AgentMessage[]): Promise<void> {
  if (!input.drainSteering) {
    return;
  }
  const steering = await input.drainSteering();
  for (const message of steering) {
    messages.push(message);
    input.onEvent?.({ type: "steering", iteration: 0, message });
  }
}

async function executeOne(execute: AgentToolExecutor, call: AgentToolCall): Promise<AgentToolResult> {
  try {
    return await execute(call);
  } catch (error) {
    // Report the failure back to the model so it can adapt, instead of killing the turn.
    return {
      content: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}

function finish(
  messages: AgentMessage[],
  effects: AgentToolEffect[],
  iterations: number,
  stoppedReason: AgentLoopStoppedReason,
): RunAgentToolLoopResult {
  const answer = lastAssistantText(messages);
  return { answer, messages, effects, iterations, stoppedReason };
}

function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "assistant" && message.content.trim() !== "") {
      return message.content;
    }
  }
  return "";
}
