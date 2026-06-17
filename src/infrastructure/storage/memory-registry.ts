import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  memoryDocumentSchema,
  memoryRecentItemSchema,
  memoryRecentQuerySchema,
  memoryRegistryQuerySchema,
  memorySearchQuerySchema,
  memorySearchResultSchema,
  type MemoryDocument,
  type MemoryDocumentKind,
  type MemoryRecentItem,
  type MemoryRecentQuery,
  type MemoryRegistryCategory,
  type MemoryRegistryQuery,
  type MemorySearchQuery,
  type MemorySearchResult,
} from "../../domain/memory/index.js";

export interface MemoryRegistryOptions {
  memoryDir: string;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_CATEGORIES: MemoryRegistryCategory[] = [
  "rules",
  "research",
  "reports",
  "proposals",
  "logs",
];
const TEXT_EXTENSIONS = new Set([".md", ".json", ".jsonl", ".txt"]);

export class MemoryRegistry {
  private readonly memoryDir: string;
  private readonly maxFileBytes: number;

  constructor(options: MemoryRegistryOptions) {
    this.memoryDir = path.resolve(options.memoryDir);
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  listDocuments(query: MemoryRegistryQuery = {}): MemoryDocument[] {
    const parsed = memoryRegistryQuerySchema.parse(query);
    const categories = resolveRegistryCategories(parsed);

    return categories
      .flatMap((category) => this.listCategoryDocuments(category))
      .filter((document) => isWithinTimeRange(document.updatedAt, parsed))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .slice(0, parsed.limit ?? Number.POSITIVE_INFINITY);
  }

  search(queryInput: MemorySearchQuery): MemorySearchResult[] {
    const query = memorySearchQuerySchema.parse(queryInput);
    const normalizedQuery = query.query.toLowerCase();
    const documents = this.listDocuments({
      category: query.category,
      categories: query.categories,
      from: query.from,
      to: query.to,
    });
    const results: MemorySearchResult[] = [];

    for (const document of documents) {
      const text = this.readSearchableText(document);

      if (!text) {
        continue;
      }

      const lower = text.toLowerCase();
      const matchCount = countMatches(lower, normalizedQuery);

      if (matchCount === 0) {
        continue;
      }

      const snippet = buildSanitizedSnippet(text, lower.indexOf(normalizedQuery), query.snippetLength);

      results.push(
        memorySearchResultSchema.parse({
          document,
          path: document.relativePath,
          summary: snippet,
          updatedAt: document.updatedAt,
          metadata: document.metadata,
          matchCount,
          snippet,
        }),
      );
    }

    return results
      .sort((left, right) => {
        if (right.matchCount !== left.matchCount) {
          return right.matchCount - left.matchCount;
        }

        return right.document.updatedAt.localeCompare(left.document.updatedAt);
      })
      .slice(0, query.limit);
  }

  recent(queryInput: MemoryRecentQuery): MemoryRecentItem[] {
    const query = memoryRecentQuerySchema.parse(queryInput);

    return this.listDocuments({
      categories: [query.category],
    })
      .flatMap((document) => this.toRecentItem(document))
      .filter((item) => isWithinTimeRange(item.updatedAt, query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, query.limit);
  }

  private listCategoryDocuments(category: MemoryRegistryCategory): MemoryDocument[] {
    const root = path.join(this.memoryDir, category);

    if (!existsSync(root)) {
      return [];
    }

    return collectFiles(root)
      .filter((filePath) => TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .map((filePath) => this.toMemoryDocument(category, filePath))
      .filter((document): document is MemoryDocument => document !== undefined);
  }

  private toMemoryDocument(
    category: MemoryRegistryCategory,
    filePath: string,
  ): MemoryDocument | undefined {
    const stat = statSync(filePath);

    if (!stat.isFile()) {
      return undefined;
    }

    const relativePath = normalizeRelativePath(path.relative(this.memoryDir, filePath));

    return memoryDocumentSchema.parse({
      category,
      documentId: safeIdentifier(path.basename(filePath, path.extname(filePath))),
      title: inferDocumentTitle(filePath),
      relativePath,
      filePath: path.resolve(filePath),
      kind: inferDocumentKind(filePath),
      updatedAt: stat.mtime.toISOString(),
      sizeBytes: stat.size,
      metadata: {
        extension: path.extname(filePath).toLowerCase(),
      },
    });
  }

  private readSearchableText(document: MemoryDocument): string | undefined {
    if (document.sizeBytes > this.maxFileBytes) {
      return undefined;
    }

    const raw = readFileSync(document.filePath, "utf8");

    if (document.kind === "json") {
      return stringifySafeJson(raw);
    }

    return raw;
  }

  private toRecentItem(document: MemoryDocument): MemoryRecentItem[] {
    if (document.category !== "research" && document.category !== "reports") {
      return [];
    }

    if (document.kind !== "json" || document.sizeBytes > this.maxFileBytes) {
      return [];
    }

    const raw = readFileSync(document.filePath, "utf8");
    const parsed = parseJsonObject(raw);

    if (!parsed) {
      return [];
    }

    const title = getString(parsed, "title") ?? document.title ?? document.documentId;
    const generatedAt = getString(parsed, "generatedAt");
    const tradingDate = getString(parsed, "tradingDate");
    const metadata = extractRecentMetadata(document.category, parsed);

    return [
      memoryRecentItemSchema.parse({
        category: document.category,
        documentId:
          getString(parsed, document.category === "research" ? "reportId" : "reportId") ??
          document.documentId,
        title,
        path: document.relativePath,
        summary: buildRecentSummary(document.category, parsed, metadata),
        relativePath: document.relativePath,
        filePath: document.filePath,
        tradingDate,
        generatedAt,
        updatedAt: generatedAt ?? document.updatedAt,
        metadata,
      }),
    ];
  }
}

function resolveRegistryCategories(query: MemoryRegistryQuery): MemoryRegistryCategory[] {
  if (query.categories !== undefined) {
    return query.categories;
  }

  if (query.category !== undefined) {
    return [query.category];
  }

  return DEFAULT_CATEGORIES;
}

function isWithinTimeRange(value: string, query: { from?: string; to?: string }): boolean {
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return false;
  }

  if (query.from !== undefined && timestamp < Date.parse(query.from)) {
    return false;
  }

  if (query.to !== undefined && timestamp > Date.parse(query.to)) {
    return false;
  }

  return true;
}

function collectFiles(root: string): string[] {
  const entries = readdirSync(root, {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const child = path.join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(child));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }

  return files;
}

function inferDocumentKind(filePath: string): MemoryDocumentKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".md":
      return "markdown";
    case ".json":
      return "json";
    case ".jsonl":
      return "jsonl";
    case ".txt":
      return "text";
    default:
      return "unknown";
  }
}

function inferDocumentTitle(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".md") {
    const raw = readFileSync(filePath, "utf8");
    const heading = raw
      .split(/\r?\n/)
      .map((line) => /^#\s+(.+)$/.exec(line.trim())?.[1]?.trim())
      .find((value): value is string => value !== undefined && value.length > 0);

    return heading;
  }

  if (extension === ".json") {
    const parsed = parseJsonObject(readFileSync(filePath, "utf8"));
    return parsed ? getString(parsed, "title") : undefined;
  }

  return undefined;
}

function stringifySafeJson(raw: string): string {
  const parsed = parseJsonObject(raw);

  if (!parsed) {
    return raw;
  }

  return JSON.stringify(redactSensitiveValue(parsed), null, 2);
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function extractRecentMetadata(
  category: "research" | "reports",
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (category === "research") {
    return {
      provider: getSanitizedString(value, "provider") ?? null,
      symbol: getSanitizedString(value, "symbol") ?? null,
      market: getSanitizedString(value, "market") ?? null,
      conclusion: getSanitizedString(value, "conclusion") ?? null,
      confidence: getNumber(value, "confidence"),
      degraded: getBoolean(value, "degraded"),
      requiresHumanReview: getBoolean(value, "requiresHumanReview"),
    };
  }

  return {
    reportType: getSanitizedString(value, "reportType") ?? null,
    period: getNestedSanitizedString(value, ["metadata", "period"]) ?? inferReportPeriod(getString(value, "reportType")),
    symbols: getNestedSanitizedStringArray(value, ["metadata", "symbols"]),
    marketSummary: getNestedSanitizedString(value, ["metadata", "marketSummary"]) ?? null,
    decisionSummary: getNestedSanitizedString(value, ["metadata", "decisionSummary"]) ?? null,
    riskNotes: getNestedSanitizedStringArray(value, ["metadata", "riskNotes"]),
    linkedAuditIds: getNestedSanitizedStringArray(value, ["metadata", "linkedAuditIds"]),
    positionCount: getNestedNumber(value, ["positionSummary", "positionCount"]),
    quoteCount: getNestedNumber(value, ["marketSummary", "quoteCount"]),
    liveTrading: getNestedBoolean(value, ["metadata", "liveTrading"]),
  };
}

function buildRecentSummary(
  category: "research" | "reports",
  value: Record<string, unknown>,
  metadata: Record<string, unknown>,
): string {
  if (category === "research") {
    const symbol = getString(value, "symbol") ?? "unknown";
    const conclusion = getString(value, "conclusion") ?? "unknown";
    return sanitizeSensitiveText(`Research ${symbol} conclusion ${conclusion}.`);
  }

  const reportType = getString(value, "reportType") ?? "report";
  const period = typeof metadata.period === "string" ? metadata.period : "unknown";
  const quoteCount = getNestedNumber(value, ["marketSummary", "quoteCount"]) ?? 0;

  return sanitizeSensitiveText(`${reportType} ${period} metadata with ${quoteCount} quote snapshots.`);
}

function countMatches(value: string, query: string): number {
  let count = 0;
  let index = value.indexOf(query);

  while (index !== -1) {
    count += 1;
    index = value.indexOf(query, index + query.length);
  }

  return count;
}

function buildSanitizedSnippet(text: string, matchIndex: number, snippetLength: number): string {
  const safeText = sanitizeSensitiveText(text).replace(/\s+/g, " ").trim();

  if (matchIndex < 0 || safeText.length <= snippetLength) {
    return trimSnippet(safeText, snippetLength);
  }

  const start = Math.max(0, matchIndex - Math.floor(snippetLength / 2));
  const snippet = safeText.slice(start, start + snippetLength);

  return `${start > 0 ? "..." : ""}${trimSnippet(snippet, snippetLength)}${
    start + snippetLength < safeText.length ? "..." : ""
  }`;
}

function trimSnippet(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(
      /\b(?:OPENAI|GEMINI|DASHSCOPE|TUSHARE|BROKER|API|SECRET|TOKEN|PASSWORD|KEY)[A-Z0-9_:-]*\s*=\s*[^\s,"'}]+/gi,
      "[REDACTED_SECRET]",
    )
    .replace(
      /("(?:api[_-]?key|token|secret|password|brokerAccountId|accountId)"\s*:\s*")([^"]+)(")/gi,
      "$1[REDACTED_SECRET]$3",
    );
}

function getSanitizedString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = getString(value, key);
  return candidate === undefined ? undefined : sanitizeSensitiveText(candidate);
}

function getNestedSanitizedString(value: Record<string, unknown>, pathParts: string[]): string | undefined {
  const candidate = getNestedValue(value, pathParts);
  return typeof candidate === "string" && candidate.trim()
    ? sanitizeSensitiveText(candidate)
    : undefined;
}

function getNestedSanitizedStringArray(value: Record<string, unknown>, pathParts: string[]): string[] {
  const candidate = getNestedValue(value, pathParts);

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => sanitizeSensitiveText(item));
}

function inferReportPeriod(reportType: string | undefined): string | null {
  switch (reportType) {
    case "pre_market_plan":
    case "midday_review":
    case "closing_review":
    case "daily_reflection":
      return "daily";
    case "weekly_review":
      return "weekly";
    case "monthly_review":
      return "monthly";
    case "yearly_review":
      return "yearly";
    default:
      return null;
  }
}

function redactSensitiveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValue);
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? "[REDACTED_SECRET]" : redactSensitiveValue(child);
    }

    return output;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|brokerAccountId|accountId/i.test(key);
}

function getString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function getNumber(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function getBoolean(value: Record<string, unknown>, key: string): boolean | null {
  const candidate = value[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function getNestedNumber(value: Record<string, unknown>, pathParts: string[]): number | null {
  const candidate = getNestedValue(value, pathParts);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function getNestedBoolean(value: Record<string, unknown>, pathParts: string[]): boolean | null {
  const candidate = getNestedValue(value, pathParts);
  return typeof candidate === "boolean" ? candidate : null;
}

function getNestedValue(value: Record<string, unknown>, pathParts: string[]): unknown {
  let current: unknown = value;

  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function safeIdentifier(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
  return safe && /^[A-Za-z0-9]/.test(safe) ? safe : "memory-document";
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}
