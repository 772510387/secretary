import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import {
  ConfigLoadError,
  loadConfig,
} from "../../src/config/index.js";
import {
  createWeChatBridgeState,
  type AgentAction,
  type WeChatBridgeDependencies,
} from "../../src/app/index.js";
import { handleAgentHttpTurn } from "../../src/interfaces/agent-http.js";
import { asToolCallingProvider } from "../../src/domain/brain/index.js";
import {
  MockBrainProvider,
  createBrainProvider,
} from "../../src/infrastructure/providers/index.js";
import {
  buildBridgeContext,
  buildLivePaperAgentTools,
  readBridgeAccountAndPositions,
} from "./build-context.js";
import { executeAgentAction } from "./agent-actions.js";

const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Local HTTP endpoint that exposes the agent brain so an external front-end can
 * drive secretary — e.g. OpenClaw's WeChat plugin receives a chat message and
 * POSTs it here, gets a reply, and sends it back in WeChat.
 *
 * Binds to 127.0.0.1 only (same-machine trust). Set AGENT_SERVER_TOKEN to also
 * require a bearer token. The model never executes tools; no real broker.
 */
export async function main(): Promise<void> {
  const config = loadConfig();
  const memoryDir = config.storage.memoryDir;
  const allowlist = config.wechat.allowedUsers;
  const token = process.env.AGENT_SERVER_TOKEN?.trim();
  const port = Number(process.env.AGENT_SERVER_PORT) || DEFAULT_PORT;
  const brainProvider =
    config.brain.provider === "mock" ? new MockBrainProvider() : createBrainProvider(config.brain);
  const toolProvider = asToolCallingProvider(brainProvider);
  const agentTools = toolProvider
    ? buildLivePaperAgentTools({
        config,
        memoryDir,
        executePaperOps: (command) => executeAgentAction({ type: "paper_ops", ...command }, { config, memoryDir }),
      })
    : undefined;
  const state = createWeChatBridgeState();

  const loadContext = (message: string) =>
    buildBridgeContext({ config, memoryDir, question: message });
  const executeAction = (action: AgentAction): Promise<string> =>
    executeAgentAction(action, { config, memoryDir });
  const depsFor = (peerId: string): WeChatBridgeDependencies => {
    const isOwner = allowlist.length > 0 && allowlist.includes(peerId);
    return {
      brainProvider,
      agentTools,
      toolProvider,
      isAllowed: () => allowlist.length === 0 || isOwner,
      allowDestructive: () => isOwner,
      loadContext,
      loadPortfolio: () => readBridgeAccountAndPositions(memoryDir),
      executeAction,
    };
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res, { token, depsFor, state }).catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });

  console.log(`agent-server 已启动：http://127.0.0.1:${port}  (POST /agent {peerId,text})`);
  console.log(token ? "已启用 bearer token 鉴权。" : "未设 AGENT_SERVER_TOKEN：仅 127.0.0.1 本机可访问。");
  console.log(
    allowlist.length > 0
      ? `owner 白名单：${allowlist.join(", ")}`
      : "未配置 owner 白名单：peerId 都可问答，危险操作禁用。",
  );
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    token?: string;
    depsFor: (peerId: string) => WeChatBridgeDependencies;
    state: ReturnType<typeof createWeChatBridgeState>;
  },
): Promise<void> {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method !== "POST" || req.url !== "/agent") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (ctx.token && !hasValidToken(req, ctx.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const payload = await readJsonBody(req);
  const peerId = isRecord(payload) && typeof payload.peerId === "string" ? payload.peerId.trim() : "";
  const result = await handleAgentHttpTurn(payload, ctx.depsFor(peerId), ctx.state);
  sendJson(res, result.status, result.body);
}

function hasValidToken(req: IncomingMessage, token: string): boolean {
  const auth = req.headers.authorization;
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = req.headers["x-agent-token"];
  const xToken = typeof header === "string" ? header.trim() : "";
  return bearer === token || xToken === token;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY_BYTES) {
        resolve({});
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();

      if (raw === "") {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigLoadError) {
      console.error(error.message);
      process.exit(1);
    }

    throw error;
  });
}
