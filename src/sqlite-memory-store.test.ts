import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { makeNode, runMemoryStoreConformance } from "./memory-store-conformance.spec.js";

// Conformance: run the shared suite against an isolated in-memory database.
runMemoryStoreConformance("SqliteMemoryStore", () => new SqliteMemoryStore(":memory:"));

// SQLite-specific: FTS5 must survive real natural-language queries. FTS5 MATCH
// treats commas, quotes, etc. as query syntax, so a raw user sentence would
// crash if passed through unsanitized.
describe("SqliteMemoryStore — full-text query safety", () => {
  it("does not throw on a punctuated multi-word query, and still matches", async () => {
    const store = new SqliteMemoryStore(":memory:");
    try {
      await store.addNode(makeNode({ content: { text: "I moved to Tokyo and love hiking" } }));
      // A raw sentence with commas/question marks — FTS5 metacharacters.
      const hits = await store.searchNodes({ query: "Wait, you're in Tokyo?! Really??" });
      expect(hits).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("returns nothing (no throw) for a query with no usable terms", async () => {
    const store = new SqliteMemoryStore(":memory:");
    try {
      await store.addNode(makeNode({ content: { text: "something" } }));
      expect(await store.searchNodes({ query: "?!,. -- ()" })).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// SQLite-specific: durability. The headline "lifelong memory" property — a
// memory written in one process is still there after the store is closed and
// reopened against the same file.
describe("SqliteMemoryStore — durability", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-buddy-memtest-"));
  const dbPath = join(dir, "memory.db");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("remembers nodes and embeddings across a close/reopen", async () => {
    const first = new SqliteMemoryStore(dbPath);
    const node = await first.addNode(makeNode({ content: { text: "remember me" } }));
    await first.setEmbedding({
      nodeId: node.nodeId,
      model: "m1",
      modelVersion: "1",
      dimensions: 2,
      metric: "cosine",
      vector: [0.5, 0.5],
    });
    first.close();

    const reopened = new SqliteMemoryStore(dbPath);
    try {
      const found = await reopened.getNode(node.nodeId);
      expect(found?.content.text).toBe("remember me");
      expect(found?.validTo).toBeNull();

      const embs = await reopened.getEmbeddings(node.nodeId);
      expect(embs).toHaveLength(1);
      expect(embs[0]?.vector).toEqual([0.5, 0.5]);

      expect(await reopened.searchNodes({ query: "remember" })).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
