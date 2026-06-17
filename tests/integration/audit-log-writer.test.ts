import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditEventSchema } from "../../src/domain/audit/index.js";
import { appendAuditEvent } from "../../src/infrastructure/logging/index.js";

const tempRoots: string[] = [];
const occurredAt = "2026-06-14T01:30:00.000Z";

describe("AuditLogWriter", () => {
  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();

      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("appends validated audit events as JSONL and backs up existing logs", () => {
    const root = createTempRoot();
    const auditPath = path.join(root, "memory", "logs", "audit-2026-06-14.jsonl");
    const firstEvent = makeAuditEvent("audit-test-0001");
    const secondEvent = makeAuditEvent("audit-test-0002");

    const first = appendAuditEvent(auditPath, firstEvent);
    const second = appendAuditEvent(auditPath, secondEvent);
    const events = readJsonLines(auditPath);

    expect(first.filePath).toBe(auditPath);
    expect(first.backupPath).toBeUndefined();
    expect(second.backupPath).toBeDefined();
    expect(existsSync(second.backupPath!)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventId: "audit-test-0001" });
    expect(events[1]).toMatchObject({ eventId: "audit-test-0002" });
  });

  it("rejects invalid audit events before writing", () => {
    const root = createTempRoot();
    const auditPath = path.join(root, "memory", "logs", "audit-2026-06-14.jsonl");
    const invalidEvent = {
      ...makeAuditEvent("audit-test-0001"),
      message: "",
    };

    expect(() => appendAuditEvent(auditPath, invalidEvent)).toThrow();
    expect(existsSync(auditPath)).toBe(false);
  });
});

function createTempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "secretary-audit-log-writer-"));
  tempRoots.push(root);
  return root;
}

function makeAuditEvent(eventId: string) {
  return auditEventSchema.parse({
    eventId,
    occurredAt,
    actor: {
      type: "system",
      id: "audit-log-writer-test",
    },
    action: "write",
    subject: {
      type: "storage",
      id: "audit-log",
    },
    severity: "info",
    result: "success",
    message: `Audit event ${eventId} written`,
    metadata: {
      liveTrading: false,
    },
  });
}

function readJsonLines(filePath: string): Array<Record<string, unknown>> {
  return readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
