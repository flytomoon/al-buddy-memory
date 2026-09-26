/**
 * 0.8.3 (founder, 2026-09-26: "optimization is fine, but loss is not fine").
 *
 * 1. Recall reads float32 vectors as views instead of converting them to
 *    arrays: measured on a real 7,354-vector store, the conversion was 65 ms of
 *    a ~117 ms first lookup, and a view costs 4 ms.
 * 2. The keyword index stops keeping its own copy of every memory's text
 *    (contentless FTS5): 57 MB -> 43 MB on the same store.
 * Both must return exactly what they returned before.
 */
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmbedder } from "./embedder.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { compareStores } from "./no-loss.js";
import { SCHEMA_VERSION, SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

const wide = (): FakeEmbedder =>
  new FakeEmbedder("wide", 64, (t) => {
    let s = 0;
    for (let i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) >>> 0;
    return Array.from(new Float32Array(Array.from({ length: 64 }, () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5)));
  });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lean-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seeded(path: string, n = 200): Promise<void> {
  const store = new SqliteMemoryStore(path);
  const r = new HybridRetriever(store, wide());
  for (let i = 0; i < n; i++) await r.indexNode(await store.addNode(makeNode({ content: { text: `Fact ${i}: sourdough, sailing and tokyo on day ${i % 30}` } })));
  store.close();
}

const queries = ["sourdough", "sailing day 4", "tokyo fact 17", "day 29", "fact 150"];

describe("recall reads vectors as views", () => {
  it("returns exactly what the array path returned", async () => {
    const path = join(dir, "v.db");
    await seeded(path);
    const store = new SqliteMemoryStore(path);
    // The same store without the fast path: what 0.8.2 did.
    const legacy: MemoryStore = new Proxy(store, { get: (t, p) => (p === "listEmbeddingVectors" ? undefined : Reflect.get(t, p, t)) }) as MemoryStore;
    for (const q of queries) {
      const fast = (await new HybridRetriever(store, wide(), { cacheTtlMs: 0 }).recall(q, { limit: 10 })).map((n) => n.nodeId);
      const slow = (await new HybridRetriever(legacy, wide(), { cacheTtlMs: 0 }).recall(q, { limit: 10 })).map((n) => n.nodeId);
      expect(fast).toEqual(slow);
    }
    expect(typeof store.listEmbeddingVectors).toBe("function");
    store.close();
  });
});

describe("the keyword index keeps no second copy of the text", () => {
  it("a new store's keyword index is contentless and still finds, ranks and forgets", async () => {
    const path = join(dir, "k.db");
    const store = new SqliteMemoryStore(path);
    const a = await store.addNode(makeNode({ content: { text: "sourdough starter notes" } }));
    await store.addNode(makeNode({ content: { text: "sourdough and sailing" } }));
    expect((await store.searchNodes({ query: "sourdough", limit: 10 })).length).toBe(2);
    await store.deleteNode(a.nodeId);
    expect((await store.searchNodes({ query: "starter", limit: 10 })).map((n) => n.nodeId)).toEqual([]);
    store.close();
    const raw = new Database(path, { readonly: true });
    const sql = (raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_fts'").get() as { sql: string }).sql;
    expect(sql).toMatch(/content\s*=\s*''/);
    expect(raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'memory_fts_content'").get()).toEqual({ n: 0 });
    raw.close();
  });

  it("an older store is converted on open, loses nothing, and shrinks after compact()", async () => {
    const before = join(dir, "before.db");
    await seeded(before, 400);
    // Make it what 0.8.2 wrote: a keyword index with its own copy of the text.
    const raw = new Database(before);
    raw.prepare("DROP TABLE memory_fts").run();
    raw.prepare("CREATE VIRTUAL TABLE memory_fts USING fts5(content_text, tokenize = 'unicode61')").run();
    raw.prepare("INSERT INTO memory_fts (rowid, content_text) SELECT fts_rowid, content_text FROM memory_nodes").run();
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    raw.prepare("VACUUM").run();
    raw.close();
    const reference = join(dir, "reference.db");
    copyFileSync(before, reference);
    // Keyword ranking straight from the index, before and after: BM25 must not move.
    const ranked = (path: string): string[][] => {
      const db = new Database(path, { readonly: true });
      const q = db.prepare(`SELECT n.node_id AS id FROM memory_nodes n JOIN (SELECT rowid AS fts_id, rank FROM memory_fts WHERE memory_fts MATCH ?) f ON n.fts_rowid = f.fts_id ORDER BY f.rank, n.node_id LIMIT 10`);
      const out = ['"sourdough"', '"sailing" OR "day"', '"tokyo" OR "fact"', '"29"'].map((m) => (q.all(m) as { id: string }[]).map((r) => r.id));
      db.close();
      return out;
    };
    const rankedBefore = ranked(reference);
    const after = join(dir, "after.db");
    copyFileSync(before, after);

    const upgraded = new SqliteMemoryStore(after);
    upgraded.compact();
    upgraded.close();
    expect(statSync(after).size).toBeLessThan(statSync(reference).size);
    expect(ranked(after)).toEqual(rankedBefore);

    // The reference must be read by the same code, so open (and upgrade) it too, then compare.
    const report = await compareStores(reference, after, { queries, embedder: wide() });
    expect(report).toMatchObject({ lossless: true, lookupsIdentical: queries.length });
  });
});
