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
