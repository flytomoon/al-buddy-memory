import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { gaugeStore } from "./gauge.js";
import { HybridRetriever } from "./hybrid-retriever.js";
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

describe("recall write cost", () => {
  const seed = async (store: MemoryStore, n: number) => {
    for (let i = 0; i < n; i++) await store.addNode(makeNode({ content: { text: `sourdough note ${i}` } }));
  };

  it("one recall is one write transaction, however many records it returns", async () => {
    const store = new SqliteMemoryStore(":memory:");
    await seed(store, 8);
    const perRecord = vi.spyOn(store, "updateNode");
    const transactions = vi.spyOn(store as unknown as { mutation: (body: () => unknown) => unknown }, "mutation");
    const hits = await new HybridRetriever(store).recall("sourdough", { limit: 8 });
    expect(hits).toHaveLength(8);
    expect(perRecord).not.toHaveBeenCalled();
    expect(transactions).toHaveBeenCalledTimes(1);
    for (const hit of hits) expect(recallCount((await store.getNode(hit.nodeId))!)).toBe(1);
    store.close();
  });

  it("a governed recall records every hit in one audited write", async () => {
    const inner = new InMemoryStore();
    await seed(inner, 5);
    const perRecord = vi.spyOn(inner, "updateNode");
    const batch = vi.spyOn(inner, "recordRecalls");
    const hits = await new HybridRetriever(govern(inner, { policies: [], context: () => ({ actor: "reader" }) })).recall("sourdough", { limit: 5 });
    expect(hits).toHaveLength(5);
    expect(perRecord).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("a store without the batch method still records each hit", async () => {
    const inner = new InMemoryStore();
    const node = await inner.addNode(makeNode());
    const plain = Object.assign(Object.create(inner) as MemoryStore, { recordRecalls: undefined });
    await recordRecallHits(plain, [node]);
    expect(recallCount((await inner.getNode(node.nodeId))!)).toBe(1);
  });

  it("the gauge records no access on the store it is timing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauge-writes-"));
    try {
      const path = join(dir, "g.db");
      const store = new SqliteMemoryStore(path);
      await seed(store, 12);
      store.close();
      const state = () => {
        const db = new Database(path, { readonly: true });
        try {
          return db.prepare("SELECT (SELECT count(*) FROM node_versions) AS versions, (SELECT group_concat(temporal_anchors) FROM memory_nodes) AS anchors").get();
        } finally {
          db.close();
        }
      };
      const before = state();
      await gaugeStore(path, { queries: ["sourdough"] });
      expect(state()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
