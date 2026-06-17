import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QMT_FAKE_BRIDGE_PROTOCOL_VERSION,
  QMT_FAKE_BRIDGE_RESULT_PREFIX,
  QmtFakeBridgeError,
  QmtFakeSubprocessBridge,
  createQmtFakeBridgeRequest,
} from "../../src/infrastructure/broker/index.js";

const tempRoots: string[] = [];

describe("QmtFakeSubprocessBridge", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("sends query-only stdin JSON protocol and parses stdout JSON data", async () => {
    const bridge = createBridge(`
      readRequest((request) => {
        if (request.protocolVersion !== "${QMT_FAKE_BRIDGE_PROTOCOL_VERSION}") {
          process.exit(11);
        }
        if (request.command !== "get_account_snapshot") {
          process.exit(12);
        }
        if (
          request.options.allowNetwork ||
          request.options.allowMiniQmt ||
          request.options.allowBroker ||
          request.options.allowOrders ||
          request.options.allowAccountSecrets
        ) {
          process.exit(13);
        }
        if (request.payload.token !== "<redacted>") {
          process.exit(14);
        }
        process.stdout.write(JSON.stringify({
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          status: "ok",
          data: {
            accountRef: request.accountRef,
            cash: {
              available: 1000,
              frozen: 0
            }
          }
        }));
      });
    `);

    const data = await bridge.run({
      requestId: "qmt-query-001",
      command: "get_account_snapshot",
      accountRef: "fake-qmt-account",
      payload: {
        token: "sk-should-redact",
      },
      timeoutMs: 1_000,
    });

    expect(data).toEqual({
      accountRef: "fake-qmt-account",
      cash: {
        available: 1000,
        frozen: 0,
      },
    });
  });

  it("parses SECRETARY_QMT_RESULT_JSON prefixed output", async () => {
    const bridge = createBridge(`
      readRequest((request) => {
        process.stdout.write("fake qmt progress log\\n");
        process.stdout.write("${QMT_FAKE_BRIDGE_RESULT_PREFIX}" + JSON.stringify({
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          status: "ok",
          data: {
            positions: []
          }
        }) + "\\n");
      });
    `);

    await expect(
      bridge.run({
        requestId: "qmt-query-prefixed",
        command: "get_positions",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({
      positions: [],
    });
  });

  it("rejects forbidden command values before spawning", () => {
    expect(() =>
      createQmtFakeBridgeRequest(
        {
          command: "submit_order" as never,
        },
        {
          requestId: "qmt-forbidden-command",
          timeoutMs: 1_000,
        },
      ),
    ).toThrow();
  });

  it("throws redacted errors for failed status and stderr", async () => {
    const bridge = createBridge(`
      readRequest((request) => {
        process.stderr.write("api_key=sk-live-secret token=raw-token Bearer bearer-secret");
        process.stdout.write(JSON.stringify({
          protocolVersion: request.protocolVersion,
          requestId: request.requestId,
          status: "error",
          error: "authorization=raw-secret failed"
        }));
      });
    `);

    try {
      await bridge.run({
        requestId: "qmt-query-error",
        command: "get_orders",
        timeoutMs: 1_000,
      });
      throw new Error("expected QmtFakeBridgeError");
    } catch (error) {
      expect(error).toBeInstanceOf(QmtFakeBridgeError);
      const message = String((error as Error).message);

      expect(message).toContain("<redacted>");
      expect(message).not.toContain("sk-live-secret");
      expect(message).not.toContain("raw-token");
      expect(message).not.toContain("bearer-secret");
      expect(message).not.toContain("raw-secret");
    }
  });

  it("terminates a fake subprocess on timeout", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "secretary-qmt-fake-bridge-"));
    tempRoots.push(tempRoot);
    const markerPath = path.join(tempRoot, "still-running.txt");
    const bridge = createBridge(
      `
        const fs = require("node:fs");
        const markerPath = process.argv[1];
        process.stdin.resume();
        setTimeout(() => {
          fs.writeFileSync(markerPath, "process was not terminated", "utf8");
        }, 250);
        setInterval(() => undefined, 1000);
      `,
      {
        args: [markerPath],
        killGraceMs: 10,
      },
    );

    await expect(
      bridge.run({
        requestId: "qmt-timeout",
        command: "health_check",
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({
      name: "QmtFakeBridgeError",
      code: "timeout",
    });
    await sleep(350);

    expect(existsSync(markerPath)).toBe(false);
  });
});

function createBridge(
  body: string,
  options: {
    args?: readonly string[];
    killGraceMs?: number;
  } = {},
): QmtFakeSubprocessBridge {
  return new QmtFakeSubprocessBridge({
    command: process.execPath,
    args: [
      "-e",
      `${readRequestHelper()}\n${body}`,
      ...(options.args ?? []),
    ],
    requestIdGenerator: () => "qmt-query-generated",
    killGraceMs: options.killGraceMs ?? 10,
  });
}

function readRequestHelper(): string {
  return `
    function readRequest(callback) {
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        callback(JSON.parse(input));
      });
    }
  `;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
