import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { recallCount, RecallRecordingError, recordRecallHits } from "./access.js";
import type { MemoryStore } from "./types/memory.js";

describe.each([
  ["memory", () => new InMemoryStore()],
  ["sqlite", () => new SqliteMemoryStore(":memory:")],
] as [string, () => MemoryStore][])("recall hit recording (%s)", (_label, make) => {
  it("counts two concurrent reads without losing either event", async () => {
    const store = make();
    const node = await store.addNode(makeNode({ content: { text: "release status" } }));
    await Promise.all([recordRecallHits(store, [node]), recordRecallHits(store, [node])]);
    expect(recallCount((await store.getNode(node.nodeId))!)).toBe(2);
  });

  it("reports attempted and succeeded writes when a hit cannot be recorded", async () => {
    const store = make();
    const node = await store.addNode(makeNode());
    await expect(recordRecallHits(store, [node, { ...node, nodeId: "missing" }])).rejects.toMatchObject({
      name: "Error",
      message: "recall hit recording failed: attempted 2, succeeded 1",
    } satisfies Partial<RecallRecordingError>);
    expect(recallCount((await store.getNode(node.nodeId))!)).toBe(1);
  });
});
