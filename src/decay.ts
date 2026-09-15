/**
 * Confidence that fades without reinforcement.
 *
 * Every node stores `decayRate` and the schema promised it (§3.5); no reader
 * used it, so a fact from July and one from September with equal confidence
 * tied forever (review 2026-09-01, idea 4). The rate is per day, applied to
 * the time since the node was last created, reinforced or modified — a fact
 * he keeps confirming stays fresh, one he never mentions again slides.
 *
 * FLOORED AT HALF. Age reorders; it never buries. An old truth still ranks
 * within a factor of two of a new one, so the memory block prefers what is
 * current without forgetting what is durable. Deterministic and pure.
 */
import { instantMs } from "./instant.js";
import type { MemoryNode } from "./types/memory.js";

const DAY_MS = 86_400_000;
export const DECAY_FLOOR = 0.5;

/** When the node was last created, reinforced or modified. */
export function lastTouched(node: Pick<MemoryNode, "temporalAnchors" | "validFrom">): number {
  let latest = Date.parse(node.validFrom) || 0;
  for (const a of node.temporalAnchors) {
    if (a.event === "created" || a.event === "reinforced" || a.event === "modified") {
      const t = Date.parse(a.timestamp);
      if (Number.isFinite(t) && t > latest) latest = t;
    }
  }
  return latest;
}

/** confidence × max(0.5, e^(−rate·days)). */
export function effectiveConfidence(
  node: Pick<MemoryNode, "confidenceWeight" | "decayRate" | "temporalAnchors" | "validFrom">,
  now: number = Date.now(),
): number {
  const rate = Number.isFinite(node.decayRate) && node.decayRate > 0 ? node.decayRate : 0;
  if (rate === 0) return node.confidenceWeight;
  const days = Math.max(0, (now - lastTouched(node)) / DAY_MS);
  return node.confidenceWeight * Math.max(DECAY_FLOOR, Math.exp(-rate * days));
}

// ---------------------------------------------------------------------------
// Recency — the last word in every ranking
// ---------------------------------------------------------------------------
//
// It lives here, beside effectiveConfidence, because it belongs to no one
// store: SQLite, the in-memory store and hybrid recall all end on it, and that
// is the point — one order, agreed everywhere. It also has to stay free of node
// built-ins, because the browser demo bundles this file and not that one.

/**
 * When the store LEARNED a fact: the `created` temporal anchor (§2.1), which is
 * exactly what the `created_at` column is written from a few lines below.
 *
 * Not `validFrom`. That is valid time — when the fact became true — and it is
 * deliberately backdatable for facts recorded after the event ("respects
 * explicit valid-time" in the conformance suite). Ordering a page by it would
 * put a fact imported today about last year below one recorded yesterday,
 * which is not what "most recent" means when you ask for ten of them.
 */
export function learnedAt(node: MemoryNode): string {
  return node.temporalAnchors.find((a) => a.event === "created")?.timestamp ?? node.validFrom;
}

/** Byte order, as SQLite's BINARY collation compares — localeCompare does not (Fable, Astra). */
export function compareBinary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Newest first, ties settled by id so two stores (and two reads) agree exactly.
 * Compared as INSTANTS, not spellings: a store written before 0.4.0 can hold
 * "…-01:00" and "…+01:00", which sort by the sign character, not by time (Astra
 * final review, 2026-09-15). The id tie-break is byte order, matching SQL.
 */
export function compareRecency(a: MemoryNode, b: MemoryNode): number {
  const x = instantMs(learnedAt(a)), y = instantMs(learnedAt(b));
  const byTime = Number.isFinite(x) && Number.isFinite(y) ? y - x : compareBinary(learnedAt(b), learnedAt(a));
  return byTime || compareBinary(b.nodeId, a.nodeId);
}
