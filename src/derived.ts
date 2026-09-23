/**
 * Conclusions and what they rest on.
 *
 * A derived fact names its sources in `contextualMetadata.derivedFrom` (the
 * consolidation pass writes it; see consolidation.ts). This module answers one
 * question for every store the same way: which facts rest on these ones,
 * directly or through another conclusion. The stores use it for the two paths a
 * source can take (SPEC §8a):
 *
 *   - it STOPPED BEING TRUE — its live conclusions are retracted, kept, marked;
 *   - it MUST NOT EXIST — it is erased with everything built from it.
 *
 * Found in our 2026-09-22 review of the erase path: erasing a fact left the
 * conclusions drawn from it standing, so what was erased could still be read in
 * their words.
 */
import type { MemoryNode } from "./types/memory.js";

export const DERIVED_FROM = "derivedFrom";

/** The source ids a fact names, or [] for a fact that rests on nothing recorded. */
export function derivedFromOf(node: Pick<MemoryNode, "contextualMetadata">): string[] {
  const raw = node.contextualMetadata[DERIVED_FROM];
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Every fact that rests on one of `roots`, directly or transitively, in the
 * order it was reached (so a conclusion comes before what was drawn from it).
 * The roots themselves are not in the result. Cycles cannot loop.
 */
export function dependentsOf(roots: readonly string[], nodes: Iterable<Pick<MemoryNode, "nodeId" | "contextualMetadata">>): string[] {
  const restsOn = new Map<string, string[]>();
  for (const n of nodes) {
    for (const source of derivedFromOf(n)) {
      const list = restsOn.get(source) ?? [];
      list.push(n.nodeId);
      restsOn.set(source, list);
    }
  }
  const seen = new Set(roots);
  const out: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const dependent of restsOn.get(id) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      out.push(dependent);
      queue.push(dependent);
    }
  }
  return out;
}

/** The record a retraction leaves on a conclusion whose source stopped being true. */
export interface SourceRetraction {
  at: string;
  by: "invalidation";
  reason: string;
}

/**
 * Whether a change is a source STOPPING being true: it had no end and now has
 * one. Moving an existing end, or clearing it, is not — and clearing it never
 * brings a retracted conclusion back (the next pass re-derives what still holds).
 */
export function isInvalidation(before: Pick<MemoryNode, "validTo">, after: Pick<MemoryNode, "validTo">): boolean {
  return before.validTo === null && after.validTo !== null;
}

/** A conclusion still in force at `at`: no end, or an end after it. */
export function isLiveAt(node: Pick<MemoryNode, "validTo">, at: string): boolean {
  return node.validTo === null || Date.parse(node.validTo) > Date.parse(at);
}

/**
 * The live conclusions to retract when `sourceId` stops being true at `until`,
 * each with the source it was reached through (the reason names that one).
 */
export function retractionsFor(
  sourceId: string,
  until: string,
  nodes: readonly Pick<MemoryNode, "nodeId" | "contextualMetadata" | "validTo">[],
): { nodeId: string; because: string }[] {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out: { nodeId: string; because: string }[] = [];
  const seen = new Set([sourceId]);
  const queue = [sourceId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const n of nodes) {
      if (seen.has(n.nodeId) || !derivedFromOf(n).includes(id)) continue;
      seen.add(n.nodeId);
      // Already withdrawn by then: left exactly as it is, and nothing drawn
      // from it is reached through it (it was not believed past its own end).
      if (!isLiveAt(byId.get(n.nodeId)!, until)) continue;
      out.push({ nodeId: n.nodeId, because: id });
      queue.push(n.nodeId);
    }
  }
  return out;
}

export function sourceRetraction(because: string, at: string): SourceRetraction {
  return { at, by: "invalidation", reason: `a source stopped being true: ${because}` };
}
