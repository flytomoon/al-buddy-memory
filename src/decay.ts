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
