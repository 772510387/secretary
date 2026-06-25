import {
  runWeChatBridgeTurn,
  type WeChatBridgeDependencies,
  type WeChatBridgeState,
} from "../app/index.js";

export interface AgentHttpResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Maps one inbound agent HTTP request to a reply, reusing the WeChat bridge brain
 * (allowlist + conversational confirmation + routing to runAgentTurn).
 *
 * This is the callable surface a front-end (OpenClaw's WeChat plugin, a Feishu bot,
 * or our own wechaty runner) uses to drive secretary. No real broker is involved.
 */
export async function handleAgentHttpTurn(
  payload: unknown,
  deps: WeChatBridgeDependencies,
  state: WeChatBridgeState,
): Promise<AgentHttpResult> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { status: 400, body: { error: "body must be a JSON object" } };
  }

  const record = payload as Record<string, unknown>;
  const peerId = record.peerId;
  const text = record.text;

  if (typeof peerId !== "string" || peerId.trim() === "") {
    return { status: 400, body: { error: "peerId is required" } };
  }

  if (typeof text !== "string") {
    return { status: 400, body: { error: "text is required" } };
  }

  const result = await runWeChatBridgeTurn({ peerId: peerId.trim(), text }, deps, state);
  return { status: 200, body: { reply: result.reply } };
}
