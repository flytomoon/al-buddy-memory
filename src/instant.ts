/**
 * One spelling per instant.
 *
 * Every timestamp in a store is compared as a string — in SQL, in both stores'
 * filters, in the ranking — and a string comparison is only a time comparison
 * when every instant is written the same way. It was not enforced: "…00Z" and
 * "…00.000Z" are the same moment and sort apart, and an offset shifted a
 * validity boundary by hours (review 2026-09-14). So every instant is
 * canonicalised on the way in to `Date#toISOString()` form — UTC, milliseconds,
 * "Z" — and anything that cannot be placed exactly is refused rather than
 * guessed at. A second implementation reading the portable format can rely on
 * the same.
 */

import type { MemoryEdge, MemoryNode, NewMemoryNode } from "./types/memory.js";

// A date (midnight UTC), or a date-time WITH a zone in extended form. A
// date-time with no zone is local time on whatever machine reads it, which is
// not an instant. Separators are case-insensitive, as RFC 3339 allows.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

export function canonicalInstant(value: string, field = "timestamp"): string {
  const m = typeof value === "string" ? ISO.exec(value.toUpperCase()) : null;
  // Date.parse rolls impossible fields forward (2026-02-30 becomes 2 March), so
  // the calendar is checked before it is trusted.
  const [, y, mo, d, h = "0", mi = "0", s = "0", oh = "0", om = "0"] = m ?? [];
  const inRange =
    m !== null &&
    +mo! >= 1 && +mo! <= 12 &&
    +d! >= 1 && +d! <= new Date(Date.UTC(+y!, +mo!, 0)).getUTCDate() &&
    +h <= 23 && +mi <= 59 && +s <= 59 && +oh <= 23 && +om <= 59;
  const ms = inRange ? Date.parse(value.toUpperCase()) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO 8601 instant with a zone (e.g. 2026-01-01T00:00:00Z) or a date; got ${JSON.stringify(value)}`);
  }
  return new Date(ms).toISOString();
}

/** Canonical, or null when the value is null/undefined (an open validity end). */
export function canonicalInstantOrNull(value: string | null | undefined, field: string): string | null {
  return value === null || value === undefined ? null : canonicalInstant(value, field);
}

type ValidityPatch = { validFrom?: string; validTo?: string | null };

/** A new fact's validity window, canonical. */
export function canonicalNew<T extends NewMemoryNode>(node: T): T {
  const out = { ...node };
  if (node.validFrom !== undefined) out.validFrom = canonicalInstant(node.validFrom, "validFrom");
  if (node.validTo !== undefined) out.validTo = canonicalInstantOrNull(node.validTo, "validTo");
  return out;
}

/** An update's validity fields, canonical; everything else untouched. */
export function canonicalPatch<T extends ValidityPatch>(patch: T): T {
  const out = { ...patch };
  if (patch.validFrom !== undefined) out.validFrom = canonicalInstant(patch.validFrom, "validFrom");
  if (patch.validTo !== undefined) out.validTo = canonicalInstantOrNull(patch.validTo, "validTo");
  return out;
}

/** A restored fact: validity and every anchor, canonical. */
export function canonicalNode(node: MemoryNode): MemoryNode {
  return {
    ...node,
    validFrom: canonicalInstant(node.validFrom, "validFrom"),
    validTo: canonicalInstantOrNull(node.validTo, "validTo"),
    temporalAnchors: (node.temporalAnchors ?? []).map((a) => ({ ...a, timestamp: canonicalInstant(a.timestamp, "temporalAnchors[].timestamp") })),
  };
}

export function canonicalEdge(edge: MemoryEdge): MemoryEdge {
  return { ...edge, createdAt: canonicalInstant(edge.createdAt, "edge.createdAt") };
}
