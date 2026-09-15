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

/** The words of a keyword query, as both stores and the governed ranking read it: letters and digits, at most 16. */
export function queryTokens(query: string): string[] {
  return (query.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);
}

/**
 * How well one fact's own text answers a query: for each query word, its share of
 * the fact's words. It depends on nothing but the fact itself — which is the point.
 * BM25 weighs words by how rare they are across the whole store, hidden facts
 * included, so a hidden fact could reorder visible results; a governed search
 * ranks by this instead (Astra final review; founder: "fix it", 2026-09-15).
 */
export function ownTextRelevance(text: string, tokens: readonly string[]): number {
  const words = (text.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => w.toLowerCase());
  if (words.length === 0) return 0;
  let hits = 0;
  for (const token of new Set(tokens.map((t) => t.toLowerCase()))) for (const w of words) if (w === token) hits += 1;
  return hits / words.length;
}
