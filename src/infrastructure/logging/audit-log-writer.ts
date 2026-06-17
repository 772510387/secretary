import { existsSync, readFileSync } from "node:fs";
import {
  auditEventSchema,
  type AuditEvent,
} from "../../domain/audit/index.js";
import {
  AtomicFileWriter,
  type AtomicWriteResult,
} from "../storage/atomic-file-writer.js";

export interface AuditLogWriterOptions {
  writer?: AtomicFileWriter;
}

export class AuditLogWriter {
  private readonly writer: AtomicFileWriter;

  constructor(options: AuditLogWriterOptions = {}) {
    this.writer = options.writer ?? new AtomicFileWriter();
  }

  append(filePath: string, event: AuditEvent): AtomicWriteResult {
    return appendAuditEvent(filePath, event, this.writer);
  }
}

export function appendAuditEvent(
  filePath: string,
  event: AuditEvent,
  writer: AtomicFileWriter = new AtomicFileWriter(),
): AtomicWriteResult {
  const parsed = auditEventSchema.parse(event);
  const previous = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const separator = previous.length > 0 && !previous.endsWith("\n") ? "\n" : "";

  return writer.write(filePath, `${previous}${separator}${JSON.stringify(parsed)}\n`);
}
