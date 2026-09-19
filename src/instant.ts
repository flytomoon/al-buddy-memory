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

import {
  ANCHOR_EVENTS,
  EDGE_PROVENANCES,
  MEMORY_NODE_TYPES,
  MEMORY_PROVENANCES,
  PRIVACY_CLASSIFICATIONS,
  RELATIONSHIP_TYPES,
  RETENTION_TIERS,
} from "./types/memory.js";
import type { MemoryEdge, MemoryNode, NewMemoryNode } from "./types/memory.js";

// A date (midnight UTC), or a date-time WITH a zone in extended form. A
// date-time with no zone is local time on whatever machine reads it, which is
// not an instant. Separators are case-insensitive, as RFC 3339 allows.
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2})))?$/;

/**
 * The instant a stored timestamp names, in milliseconds — for ORDERING, including
 * values written before 0.4.0 that the write-time rules would now refuse. Every
 * comparison of instants (the stores' ranking, their migration, consolidation,
 * pins) goes through this one function, so SQL's sort key and JS's order are
 * computed the same way: same case-folding, same millisecond truncation (SQLite's
 * own strftime rounds, which is why the migration no longer uses it). NaN when
 * there is no instant to find.
 */
export function instantMs(value: string | null | undefined): number {
  // Only an ISO 8601 date or date-time WITH a zone is an instant. Date.parse guesses
  // at anything else — a zone-less time in the machine's zone, "1" as the year 2001 —
  // and a guess is not an instant (Fable, 2026-09-15).
  if (typeof value !== "string") return Number.NaN;
  const upper = value.toUpperCase();
  return ISO.test(upper) ? Date.parse(upper) : Number.NaN;
}

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

type ValidityPatch = { validFrom?: string; validTo?: string | null; confidenceWeight?: number; decayRate?: number };

/**
 * Confidence is a weight in [0,1]; decay is a rate ≥ 0. Nothing checked either,
 * and exact paging rests on effective ≤ stored, which a negative confidence
 * breaks (Fable final review, 2026-09-15). Checked on every write path, here,
 * because every write path already passes through this module.
 */
function assertWeights(v: { confidenceWeight?: number; decayRate?: number }): void {
  if (v.confidenceWeight !== undefined && !(Number.isFinite(v.confidenceWeight) && v.confidenceWeight >= 0 && v.confidenceWeight <= 1)) {
    throw new Error(`confidenceWeight must be a number in [0, 1]; got ${String(v.confidenceWeight)}`);
  }
  if (v.decayRate !== undefined && !(Number.isFinite(v.decayRate) && v.decayRate >= 0)) {
    throw new Error(`decayRate must be a finite number ≥ 0; got ${String(v.decayRate)}`);
  }
}

/**
 * One spelling per word, too.
 *
 * The weights were checked and the vocabulary was not, so a JavaScript caller,
 * an import, or a port in another language could write `provenance:"Hacker"`,
 * `memoryType:"Whatever"`, `retentionTier:"Forever"` — and, worst of the four,
 * `privacyClassification:"sensitive"`. That last one is not pedantry: every
 * governance rule in this library compares the classification by string
 * equality, so a fact the person spelled in lower case is not Sensitive to any
 * policy and IS returned to a stranger. The store's own export then failed the
 * published schema under ajv. TypeScript callers were never able to do this;
 * everyone else now gets the same refusal they do (Astra R8 + Fable,
 * 2026-09-18).
 */
function assertOneOf(value: unknown, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value as string)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
}

type NodeWords = Partial<Pick<MemoryNode, "provenance" | "memoryType" | "privacyClassification" | "retentionTier">>;

/**
 * The classification words of a whole fact — all four required, because a fact
 * is not a fact without them. (SQLite's NOT NULL caught a missing provenance a
 * row too late, and the in-memory store had no backstop at all.)
 */
export function assertNodeVocabulary(node: NodeWords): void {
  assertOneOf(node.provenance, MEMORY_PROVENANCES, "provenance");
  assertOneOf(node.memoryType, MEMORY_NODE_TYPES, "memoryType");
  assertOneOf(node.privacyClassification, PRIVACY_CLASSIFICATIONS, "privacyClassification");
  assertOneOf(node.retentionTier, RETENTION_TIERS, "retentionTier");
}

/** The same words in a patch, where a key that is absent simply is not changing. */
function assertPatchVocabulary(patch: NodeWords): void {
  if ("memoryType" in patch) assertOneOf(patch.memoryType, MEMORY_NODE_TYPES, "memoryType");
  if ("privacyClassification" in patch) assertOneOf(patch.privacyClassification, PRIVACY_CLASSIFICATIONS, "privacyClassification");
  if ("retentionTier" in patch) assertOneOf(patch.retentionTier, RETENTION_TIERS, "retentionTier");
  // provenance is immutable: assertPatchMutable refuses it before it gets here.
}

/** A lifecycle event on a fact's append-only trail. The schema publishes the list. */
export function assertAnchorEvent(event: unknown): void {
  assertOneOf(event, ANCHOR_EVENTS, "temporalAnchors[].event");
}

/**
 * A link's vocabulary and its weight. `addEdge` takes an edge without an id or
 * a createdAt, so the check lives here rather than in {@link canonicalEdge},
 * and both write paths call it.
 */
export function assertEdge(edge: Pick<MemoryEdge, "relationshipType" | "strength" | "provenance">): void {
  assertOneOf(edge.relationshipType, RELATIONSHIP_TYPES, "relationshipType");
  assertOneOf(edge.provenance, EDGE_PROVENANCES, "edge provenance");
  if (!(Number.isFinite(edge.strength) && edge.strength >= 0 && edge.strength <= 1)) {
    throw new Error(`edge strength must be a number in [0, 1]; got ${String(edge.strength)}`);
  }
}

/** A new fact's validity window, canonical. */
export function canonicalNew<T extends NewMemoryNode>(node: T): T {
  assertWeights(node);
  assertNodeVocabulary(node);
  const out = { ...node };
  if (node.validFrom !== undefined) out.validFrom = canonicalInstant(node.validFrom, "validFrom");
  if (node.validTo !== undefined) out.validTo = canonicalInstantOrNull(node.validTo, "validTo");
  return out;
}

/**
 * An update's validity fields, canonical; everything else untouched.
 *
 * A key whose value is `undefined` is DROPPED. In JavaScript
 * `{validTo: undefined}` is how an omitted key arrives — a caller spreading an
 * optional field, or JSON that never had one — and spreading it over the stored
 * fact used to leave `validTo: undefined` in memory: the fact fell out of every
 * validAt read, reported itself not current, and failed the export schema,
 * while SQLite made a different mess of the same patch (Fable, 2026-09-18).
 * Erasing a field is not something a patch can express; closing a fact's
 * validity is `validTo: null` or an instant.
 */
export function canonicalPatch<T extends ValidityPatch>(patch: T): T {
  const out = {} as T;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  assertWeights(out);
  // A patch's classification fields are outside ValidityPatch's shape but very
  // much inside what updateNode accepts, so they are checked by key.
  assertPatchVocabulary(out as NodeWords);
  if (out.validFrom !== undefined) out.validFrom = canonicalInstant(out.validFrom, "validFrom");
  if (out.validTo !== undefined) out.validTo = canonicalInstantOrNull(out.validTo, "validTo");
  return out;
}

/** A restored fact: validity and every anchor, canonical. */
export function canonicalNode(node: MemoryNode): MemoryNode {
  assertWeights(node);
  assertNodeVocabulary(node);
  return {
    ...node,
    validFrom: canonicalInstant(node.validFrom, "validFrom"),
    validTo: canonicalInstantOrNull(node.validTo, "validTo"),
    temporalAnchors: (node.temporalAnchors ?? []).map((a) => {
      assertAnchorEvent(a?.event);
      return { ...a, timestamp: canonicalInstant(a.timestamp, "temporalAnchors[].timestamp") };
    }),
  };
}

export function canonicalEdge(edge: MemoryEdge): MemoryEdge {
  assertEdge(edge);
  return { ...edge, createdAt: canonicalInstant(edge.createdAt, "edge.createdAt") };
}
