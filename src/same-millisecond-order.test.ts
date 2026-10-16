import { describe, expect, it } from "vitest";
import { compareRecency } from "./decay.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

/** Issue #5: facts written in the same millisecond came back in random order. */
describe("facts written back to back keep their write order", () => {
  for (const [label, make] of [
    ["InMemoryStore", () => new InMemoryStore()],
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
  ] as [string, () => MemoryStore][]) {
    it(`${label}: 50 facts in a tight loop sort by recency in write order`, async () => {
      const store = make();
      const written: string[] = [];
      for (let i = 0; i < 50; i++) written.push((await store.addNode(makeNode({ content: { text: `fact ${i}` } }))).nodeId);
      // compareRecency is newest first; before the fix, same-millisecond facts tied and fell to the random id.
      const newestFirst = [...(await store.listNodes())].sort(compareRecency).map((n) => n.nodeId);
      expect(newestFirst).toEqual([...written].reverse());
    });
  }
});

describe("newNodeId", () => {
  it("is a UUIDv7 and sorts in creation order, even within one millisecond", async () => {
    const { newNodeId } = await import("./node-id.js");
    const ids = Array.from({ length: 5000 }, () => newNodeId());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
