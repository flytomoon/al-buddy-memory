import type { MemoryNode, MemoryStore } from "./types/memory.js";

export class RecallRecordingError extends Error {
  constructor(attempted: number, succeeded: number, cause: unknown) {
    super(`recall hit recording failed: attempted ${attempted}, succeeded ${succeeded}`, { cause });
  }
}

/** Record only facts returned to a caller. Stores append the event under their write lock. */
export async function recordRecallHits(store: MemoryStore, hits: readonly MemoryNode[]): Promise<MemoryNode[]> {
  const recorded: MemoryNode[] = [];
  for (const hit of hits) {
    try {
      recorded.push(await store.updateNode(hit.nodeId, {}, "recalled"));
    } catch (cause) {
      throw new RecallRecordingError(recorded.length + 1, recorded.length, cause);
    }
  }
  return recorded;
}

export function recallCount(node: Pick<MemoryNode, "temporalAnchors">): number {
  return node.temporalAnchors.filter((a) => a.event === "recalled").length;
}
