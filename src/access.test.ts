import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { recallCount, RecallRecordingError, recordRecallHits } from "./access.js";
import { govern, exportView } from "./governance/governed-store.js";
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

it("a reader can record an access without permission to edit the fact", async () => {
  const inner = new InMemoryStore();
  const node = await inner.addNode(makeNode());
  const reader = govern(inner, {
    policies: [{ name: "read-only", beforeUpdate: () => { throw new Error("edits denied"); } }],
    context: () => ({ actor: "reader" }),
  });
  expect((await recordRecallHits(reader, [node]))[0]!.temporalAnchors.some((a) => a.event === "recalled")).toBe(false);
  expect(recallCount((await inner.getNode(node.nodeId))!)).toBe(1);
  await expect(reader.updateNode(node.nodeId, {}, "modified")).rejects.toThrow("edits denied");
  const exportOnly = exportView(inner, { policies: [], context: () => ({ actor: "reader" }) });
  await expect(recordRecallHits(exportOnly, [node])).rejects.toMatchObject({
    message: "recall hit recording failed: attempted 1, succeeded 0",
    cause: expect.objectContaining({ message: "exportView is read-only" }),
  });
});
