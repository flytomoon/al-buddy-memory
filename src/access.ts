import type { MemoryNode, MemoryStore } from "./types/memory.js";

export class RecallRecordingError extends Error {
  constructor(attempted: number, succeeded: number, cause: unknown) {
    super(`recall hit recording failed: attempted ${attempted}, succeeded ${succeeded}`, { cause });
  }
}

// Access accounting is operational history, not a change to the fact the caller
// recalled. Keep repeated reads of the same fact stable on the wire.
const withoutRecallAnchors = (node: MemoryNode): MemoryNode => ({ ...node, temporalAnchors: node.temporalAnchors.filter((a) => a.event !== "recalled") });

/**
 * Record only facts returned to a caller. A store with `recordRecalls` takes
 * the whole recall as one write; any other store is written once per hit.
 */
export async function recordRecallHits(store: MemoryStore, hits: readonly MemoryNode[]): Promise<MemoryNode[]> {
  if (hits.length === 0) return [];
  if (store.recordRecalls) {
    let recorded: MemoryNode[];
    try {
      recorded = await store.recordRecalls(hits.map((h) => h.nodeId));
    } catch (cause) {
      throw new RecallRecordingError(hits.length, 0, cause);
    }
    if (recorded.length < hits.length) {
      throw new RecallRecordingError(recorded.length + 1, recorded.length, new Error(`Memory node not found: ${hits[recorded.length]!.nodeId}`));
    }
    return recorded.map(withoutRecallAnchors);
  }
  const recorded: MemoryNode[] = [];
  for (const hit of hits) {
    try {
      recorded.push(withoutRecallAnchors(await store.updateNode(hit.nodeId, {}, "recalled")));
    } catch (cause) {
      throw new RecallRecordingError(recorded.length + 1, recorded.length, cause);
    }
  }
  return recorded;
}

export function recallCount(node: Pick<MemoryNode, "temporalAnchors">): number {
  return node.temporalAnchors.filter((a) => a.event === "recalled").length;
}
