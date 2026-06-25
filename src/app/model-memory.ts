import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { auditEventSchema } from "../domain/audit/index.js";
import { toBeijingDate } from "../domain/shared/index.js";
import { AtomicFileWriter } from "../infrastructure/storage/atomic-file-writer.js";
import { appendAuditEvent } from "../infrastructure/logging/index.js";
import {
  createPortfolioMemoryPaths,
  MemoryRegistry,
  type MemoryRegistryOptions,
} from "../infrastructure/storage/index.js";
import type { MemoryRegistryCategory } from "../domain/memory/index.js";

/**
 * MEM-05/07: the model's read/write access to its own long-term memory, behind guardrails.
 *
 * Read (searchModelMemory): a bounded, read-only keyword/structured query over the
 * knowledge categories. Write (rememberModelNote): an APPEND-ONLY note to a FIXED file —
 * the model never supplies a path, so it can never touch the 宪法 (MEMORY/rules), the
 * financial ledger, or secrets. Hard rules are NOT changed here (that stays on the
 * review-required proposal path); this only persists a soft lesson/observation.
 */

/** Categories the read tool may search — knowledge only; never config/secrets paths. */
const SEARCHABLE_CATEGORIES: readonly MemoryRegistryCategory[] = [
  "long_term",
  "daily_logs",
  "weekly_reviews",
  "monthly_reviews",
  "yearly_reviews",
  "history",
  "reports",
  "research",
  "rules",
];

const MAX_SEARCH_RESULTS = 8;
const MAX_NOTE_LENGTH = 600;
const MAX_TAGS = 6;

export interface SearchModelMemoryInput {
  memoryDir: string;
  query: string;
  from?: string;
  to?: string;
  limit?: number;
  /** Restrict to specific categories (default: the knowledge allowlist). */
  categories?: readonly MemoryRegistryCategory[];
  registryOptions?: Partial<MemoryRegistryOptions>;
}

export interface ModelMemoryHit {
  path: string;
  snippet: string;
  updatedAt: string;
  matchCount: number;
}

export interface SearchModelMemoryResult {
  ok: boolean;
  count: number;
  hits: ModelMemoryHit[];
}

/**
 * Read-only, bounded memory search. The registry matches the whole query as ONE substring,
 * so we tokenize on whitespace and search PER token, then merge by path (summing match counts)
 * — that way "风华高科 厦门银行" or "大盘跳水 护盘" actually hit, instead of needing the exact
 * phrase. Returns at most MAX_SEARCH_RESULTS trimmed hits, ranked by total match count.
 */
export function searchModelMemory(input: SearchModelMemoryInput): SearchModelMemoryResult {
  try {
    const registry = new MemoryRegistry({
      memoryDir: input.memoryDir,
      ...input.registryOptions,
    });
    const limit = Math.min(input.limit ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
    const categories = [...(input.categories ?? SEARCHABLE_CATEGORIES)];
    const tokens = tokenizeQuery(input.query);

    const merged = new Map<string, ModelMemoryHit>();
    for (const token of tokens) {
      for (const result of registry.search({
        query: token,
        categories,
        from: input.from,
        to: input.to,
        limit: MAX_SEARCH_RESULTS,
        snippetLength: 240,
      })) {
        const existing = merged.get(result.path);
        if (existing) {
          existing.matchCount += result.matchCount;
          if (result.matchCount > 0 && existing.snippet.length < result.snippet.length) {
            existing.snippet = result.snippet;
          }
        } else {
          merged.set(result.path, {
            path: result.path,
            snippet: result.snippet,
            updatedAt: result.updatedAt,
            matchCount: result.matchCount,
          });
        }
      }
    }

    const hits = [...merged.values()]
      .sort((left, right) =>
        right.matchCount !== left.matchCount
          ? right.matchCount - left.matchCount
          : right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, limit);
    return { ok: true, count: hits.length, hits };
  } catch {
    return { ok: false, count: 0, hits: [] };
  }
}

/** Split a query into searchable tokens (drop 1-char noise); fall back to the whole query. */
function tokenizeQuery(query: string): string[] {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 6);
  return tokens.length > 0 ? [...new Set(tokens)] : [query.trim()].filter(Boolean);
}

export const rememberModelNoteArgsSchema = z
  .object({
    note: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
    tags: z.array(z.string().trim().min(1).max(24)).max(MAX_TAGS).optional(),
    kind: z.enum(["lesson", "observation", "mistake", "rule_idea"]).default("lesson"),
  })
  .strict();

export type RememberModelNoteArgs = z.infer<typeof rememberModelNoteArgsSchema>;

export interface RememberModelNoteInput {
  memoryDir: string;
  note: string;
  tags?: string[];
  kind?: RememberModelNoteArgs["kind"];
  now?: Date | string;
}

export interface RememberModelNoteResult {
  ok: boolean;
  path?: string;
  reason?: string;
}

const KIND_LABEL: Record<RememberModelNoteArgs["kind"], string> = {
  lesson: "教训",
  observation: "观察",
  mistake: "失误",
  rule_idea: "规则设想（仅记录,不自动生效）",
};

/**
 * Append-only guarded memory write. Destination is FIXED (long_term/<YYYY-MM>/model-notes.md);
 * the caller/model cannot choose a path. Content is sanitized and length-capped, and every
 * write is audited. Returns ok:false (never throws) so a write failure can't break a turn.
 */
export function rememberModelNote(input: RememberModelNoteInput): RememberModelNoteResult {
  const parsed = rememberModelNoteArgsSchema.safeParse({
    note: input.note,
    tags: input.tags,
    kind: input.kind,
  });
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "invalid_note" };
  }

  const note = sanitizeText(parsed.data.note).slice(0, MAX_NOTE_LENGTH);
  if (note === "") {
    return { ok: false, reason: "empty_after_sanitize" };
  }
  const tags = (parsed.data.tags ?? []).map((tag) => sanitizeText(tag)).filter(Boolean);

  try {
    const nowIso = normalizeNow(input.now);
    const yearMonth = toBeijingDate(nowIso).date.slice(0, 7);
    const filePath = path.join(path.resolve(input.memoryDir), "long_term", yearMonth, "model-notes.md");

    const tagSuffix = tags.length > 0 ? `  [tags: ${tags.join(", ")}]` : "";
    const section = `## ${KIND_LABEL[parsed.data.kind]} (${nowIso})\n- ${note}${tagSuffix}\n`;

    let body: string;
    if (existsSync(filePath)) {
      const prior = readFileSync(filePath, "utf8").trimEnd();
      body = prior.length > 0 ? `${prior}\n\n${section}` : section;
    } else {
      body = `# 大脑笔记 · ${yearMonth}（模型自留,只读不改规则）\n\n${section}`;
    }
    new AtomicFileWriter().write(filePath, body.endsWith("\n") ? body : `${body}\n`);

    writeRememberAudit(input.memoryDir, nowIso, parsed.data.kind, note);
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function writeRememberAudit(memoryDir: string, nowIso: string, kind: string, note: string): void {
  try {
    const auditLogPath = createPortfolioMemoryPaths(memoryDir, nowIso).auditLogPath;
    appendAuditEvent(
      auditLogPath,
      auditEventSchema.parse({
        eventId: `audit-memory-write-${Date.parse(nowIso)}`.slice(0, 128),
        occurredAt: nowIso,
        actor: { type: "brain", id: "model-memory" },
        action: "write",
        subject: { type: "memory", id: "model-notes" },
        severity: "info",
        result: "success",
        message: `大脑写入长期记忆笔记（${kind}）：${note.slice(0, 80)}`,
        correlationId: `memory-write-${Date.parse(nowIso)}`.slice(0, 128),
        metadata: {
          kind,
          target: "long_term/model-notes.md",
          ruleMutation: false,
          brokerConnected: false,
          liveTrading: false,
        },
      }),
    );
  } catch {
    // Audit is best-effort; a note must still persist even if the audit write fails.
  }
}

/** Redact secret-shaped tokens and collapse control chars/whitespace into one clean line. */
function sanitizeText(value: string): string {
  const redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret|credential)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]");
  let stripped = "";
  for (const ch of redacted) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return stripped.replace(/\s+/g, " ").trim();
}

function normalizeNow(now: Date | string | undefined): string {
  if (now instanceof Date) {
    return Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
  }
  if (typeof now === "string") {
    const parsed = new Date(now);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return new Date().toISOString();
}
