import type { MemoryEdge, MemoryNode } from "./types/memory.js";

/**
 * The fields a fact can never change after it is written. Provenance is the
 * whole point: a fact that could be re-labelled "UserInput" after the fact is
 * a fact nobody can weigh. Content is the other half: raw text is the source
 * of truth, so a correction is a NEW fact plus `validTo` on the old one, never
 * an overwrite. The store enforces this at runtime, not only in the types, so a
 * JavaScript caller gets the same refusal a TypeScript one does.
 */
export const IMMUTABLE_NODE_FIELDS = ["nodeId", "provenance", "encryptionKeyRef", "temporalAnchors", "content"] as const;

export function assertPatchMutable(patch: object): void {
  for (const field of IMMUTABLE_NODE_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      throw new Error(`${field} is immutable: it is set when the fact is written and never changes (write a new fact and invalidate this one with validTo instead)`);
    }
  }
}

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  const x = Date.parse(a ?? ""), y = Date.parse(b ?? "");
  return Number.isFinite(x) && x === y;
}

/** Key-order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

/**
 * The rule for restoreNode, the import path. A restored fact must carry its
 * creation anchor first. Over an existing fact it may bring newer mutable state
 * (validity, confidence, tiers, metadata) and a LONGER anchor trail — history
 * appended since — but never a different provenance, key reference or content,
 * and never a trail that rewrites or drops what is already recorded.
 */
export function assertRestorable(incoming: MemoryNode, existing?: MemoryNode): void {
  if (incoming.temporalAnchors?.[0]?.event !== "created") {
    throw new Error(`cannot restore ${incoming.nodeId}: its history must begin with a "created" anchor`);
  }
  if (!existing) return;
  for (const field of ["provenance", "encryptionKeyRef", "content"] as const) {
    if (canonical(existing[field]) !== canonical(incoming[field])) {
      throw new Error(`cannot restore ${incoming.nodeId}: ${field} is immutable and differs from the stored fact`);
    }
  }
  const had = existing.temporalAnchors;
  const brings = incoming.temporalAnchors;
  // Compared as instants: a store written before 0.4.0 can hold an anchor as
  // "…00Z" that a canonical copy spells "…00.000Z" — the same moment.
  const extends_ = brings.length >= had.length && had.every((a, i) => a.event === brings[i]?.event && sameInstant(a.timestamp, brings[i]?.timestamp));
  if (!extends_) {
    throw new Error(`cannot restore ${incoming.nodeId}: its history is append-only, and this copy rewrites or drops recorded anchors`);
  }
}

/**
 * There is no updateEdge: a link says what it says. Re-importing an identical
 * link is a no-op (the return value says so); anything else over an existing id
 * is refused. Replacing it used to be allowed, which let a caller refused an
 * erasure rewrite the link instead (Astra re-review, 2026-09-15).
 */
export function edgeRestoreIsNoop(incoming: MemoryEdge, existing: MemoryEdge | undefined): boolean {
  if (!existing) return false;
  if (canonical(existing) !== canonical(incoming)) {
    throw new Error(`cannot restore edge ${incoming.edgeId}: a link is immutable and this copy differs from the stored one`);
  }
  return true;
}
