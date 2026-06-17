/**
 * Coerces common real-model deviations in the `citations` field into the
 * BrainOutput contract before local validation.
 *
 * Models frequently return citations as plain strings (e.g. ["source A"]) or as
 * objects missing the required `sourceType`. Rather than reject an otherwise good
 * answer, the provider adapters normalize these into valid citation objects.
 * Shapes we cannot safely coerce are left untouched so validation still rejects them.
 */
const CITATION_SOURCE_TYPES = new Set(["user", "memory", "market", "research", "news", "system"]);

export function normalizeBrainCitations(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((entry) => {
    if (typeof entry === "string") {
      const title = entry.trim().slice(0, 300);
      return { title: title.length > 0 ? title : "untitled", sourceType: "system" };
    }

    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const url =
        typeof record.url === "string" && /^https?:\/\//i.test(record.url.trim())
          ? record.url.trim()
          : undefined;
      const rawTitle = typeof record.title === "string" ? record.title.trim() : "";
      const title = (rawTitle || url || "untitled").slice(0, 300);
      const sourceType =
        typeof record.sourceType === "string" && CITATION_SOURCE_TYPES.has(record.sourceType)
          ? record.sourceType
          : url
            ? "news"
            : "system";
      // Rebuild a strict-schema-clean object, dropping unknown keys (content, score, ...).
      const clean: Record<string, unknown> = { title, sourceType };

      if (url) {
        clean.url = url;
      }

      if (typeof record.note === "string" && record.note.trim() !== "") {
        clean.note = record.note.trim().slice(0, 1000);
      }

      return clean;
    }

    return entry;
  });
}

const PROPOSAL_TYPES = new Set([
  "trade_intent_draft",
  "memory_write",
  "research_task",
  "notification",
]);

/**
 * Defensively normalizes the `proposals` field from a real model.
 *
 * Proposals are the formal review-required artifacts (trade drafts, memory
 * writes, ...), so a malformed one cannot be acted on anyway. We drop entries
 * that are not salvageable objects (e.g. plain strings) and coerce the rest into
 * a valid shape (safe id, forced requiresReview=true). The model's free-text
 * answer still lives in `summary`/`structured`, so nothing actionable is lost.
 */
export function normalizeBrainProposals(value: unknown): unknown {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    return value;
  }

  const proposals: unknown[] = [];

  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.type !== "string" || !PROPOSAL_TYPES.has(record.type)) {
      continue;
    }

    if (typeof record.title !== "string" || record.title.trim() === "") {
      continue;
    }

    if (typeof record.rationale !== "string" || record.rationale.trim() === "") {
      continue;
    }

    if (record.payload === undefined) {
      continue;
    }

    const proposalId =
      typeof record.proposalId === "string" && record.proposalId.trim() !== ""
        ? toSafeIdentifier(record.proposalId)
        : `proposal-${proposals.length + 1}`;

    proposals.push({ ...record, proposalId, requiresReview: true });
  }

  return proposals;
}

function toSafeIdentifier(value: string): string {
  const safe = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "");

  return (safe || "proposal").slice(0, 128);
}
