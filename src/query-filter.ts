/**
 * The store's filter semantics as a plain predicate, for candidates that did not
 * come out of `searchNodes` — the vector hits in {@link HybridRetriever}. It mirrors
 * InMemoryStore and SqliteMemoryStore exactly, governance defaults included:
 * Sealed never surfaces unless named, and Archived / PendingDeletion stay out of
 * active context unless named. One definition, so a filter can never mean one
 * thing on the keyword path and another on the vector path.
 */
import type { MemoryNode, MemoryQueryOptions } from "./types/memory.js";

export type NodeFilter = Pick<
  MemoryQueryOptions,
  "memoryType" | "privacyClassification" | "retentionTier" | "tags" | "minConfidence" | "validAt"
>;

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
  if (filter.tags?.length) {
    const tags = node.contextualMetadata["tags"];
    if (!Array.isArray(tags) || !filter.tags.some((t) => (tags as unknown[]).includes(t))) return false;
  }
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

/** The words of a keyword query, as both stores and the governed ranking read it: letters and digits, at most 16. */
export function queryTokens(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
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
