/**
 * The store's filter semantics as a plain predicate, for candidates that did not
 * come out of `searchNodes` — the vector hits in {@link HybridRetriever}. It mirrors
 * InMemoryStore and SqliteMemoryStore exactly, governance defaults included:
 * Sealed never surfaces unless named, and Archived / PendingDeletion stay out of
 * active context unless named. One definition, so a filter can never mean one
 * thing on the keyword path and another on the vector path.
 */
import type { LabelFilter, MemoryNode, MemoryQueryOptions } from "./types/memory.js";

export type NodeFilter = Pick<
  MemoryQueryOptions,
  "memoryType" | "privacyClassification" | "retentionTier" | "tags" | "minConfidence" | "validAt" | "labels"
>;

/** Whether a fact's labels pass a {@link LabelFilter} — the one definition the SQL in both stores compiles. */
export function matchesLabels(node: Pick<MemoryNode, "contextualMetadata">, filter: LabelFilter): boolean {
  if ("all" in filter) return filter.all.every((f) => matchesLabels(node, f));
  if ("any" in filter) return filter.any.some((f) => matchesLabels(node, f));
  if (!Object.prototype.hasOwnProperty.call(node.contextualMetadata, filter.label)) return false;
  const value = node.contextualMetadata[filter.label];
  if (typeof value === "string") return filter.in.includes(value);
  return Array.isArray(value) && value.some((v) => typeof v === "string" && filter.in.includes(v));
}

/** Whether a fact carries one of the tags (`contextualMetadata.tags`), as every store matches `tags`. */
export function matchesTags(node: Pick<MemoryNode, "contextualMetadata">, wanted: readonly string[]): boolean {
  const tags = node.contextualMetadata["tags"];
  return Array.isArray(tags) && wanted.some((t) => (tags as unknown[]).includes(t));
}

/** AND of two optional filters; undefined when neither is given. */
export function bothLabels(a: LabelFilter | undefined, b: LabelFilter | undefined): LabelFilter | undefined {
  return a === undefined ? b : b === undefined ? a : { all: [a, b] };
}

export function matchesFilter(node: MemoryNode, filter: NodeFilter): boolean {
  if (filter.memoryType !== undefined) {
    const types = Array.isArray(filter.memoryType) ? filter.memoryType : [filter.memoryType];
    if (!types.includes(node.memoryType)) return false;
  }
  if (filter.privacyClassification?.length) {
    if (!filter.privacyClassification.includes(node.privacyClassification)) return false;
  } else if (node.privacyClassification === "Sealed") {
    return false;
  }
  if (filter.retentionTier?.length) {
    if (!filter.retentionTier.includes(node.retentionTier)) return false;
  } else if (node.retentionTier === "Archived" || node.retentionTier === "PendingDeletion") {
    return false;
  }
  if (filter.tags?.length && !matchesTags(node, filter.tags)) return false;
  if (filter.labels !== undefined && !matchesLabels(node, filter.labels)) return false;
  if (filter.minConfidence !== undefined && node.confidenceWeight < filter.minConfidence) return false;
  if (filter.validAt !== undefined) {
    if (node.validFrom > filter.validAt) return false;
    if (node.validTo !== null && node.validTo <= filter.validAt) return false;
  }
  return true;
}

/**
 * What a `limit` means, on every store: none given, or one that is not a finite
 * number, is no limit; a negative is zero; a fraction rounds down. The stores
 * used to disagree — `-1` was nothing on SQLite and all-but-the-last in memory,
 * `NaN` everything on one and nothing on the other (review 2026-09-22).
 */
export function normaliseLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const n = Number(limit);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : undefined;
}

/** How many words of a keyword query the stores read; the rest are not searched. */
export const MAX_QUERY_TOKENS = 16;

/** The words of a keyword query, as both stores and the governed ranking read it: letters and digits, at most 16. */
export function queryTokens(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_QUERY_TOKENS);
}

/** Whether the text holds any of the words, whole and case-insensitive: how InMemoryStore matches a query. */
export function mentionsAny(text: string, tokens: readonly string[]): boolean {
  const wanted = new Set(tokens.map((t) => t.toLowerCase()));
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).some((w) => wanted.has(w.toLowerCase()));
}

/**
 * Relevance of each visible match to a query, computed ONLY from the visible
 * matches: for each query word, its share of a fact's words, weighted by how rare
 * the word is among these matches (log(1 + N/df)). Two properties, both tested:
 *
 * - Hidden facts cannot move it. The store decides which facts match fact by fact,
 *   so hidden facts cannot change the visible set — and N and df are counted over
 *   that set alone. BM25's word weights come from every fact in the store, hidden
 *   ones included, which let a hidden fact reorder visible results (Astra).
 * - Common words do not drown the rare one. Plain term frequency ranked facts
 *   dense in "the / is / my" above the fact containing "wifi" for "what is the wifi
 *   login" (Fable, 2026-09-15); the rarity weight fixes that.
 */
export function visibleRelevance(texts: readonly string[], tokens: readonly string[]): number[] {
  const wanted = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const docs = texts.map((text) => (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase()));
  const df = new Map(wanted.map((t) => [t, docs.filter((words) => words.includes(t)).length]));
  const n = docs.length;
  return docs.map((words) => {
    if (words.length === 0) return 0;
    let score = 0;
    for (const t of wanted) {
      const tf = words.reduce((c, w) => c + (w === t ? 1 : 0), 0);
      if (tf > 0) score += (tf / words.length) * Math.log(1 + n / (df.get(t) || 1));
    }
    return score;
  });
}
