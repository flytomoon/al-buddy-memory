import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmbedder } from "./embedder.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { compareStores } from "./no-loss.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";

const fake = (): FakeEmbedder =>
  new FakeEmbedder("fake", 8, (t) => Array.from(new Float32Array(Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 13) / 13))));

let dir: string;
let before: string;
let after: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "noloss-"));
  before = join(dir, "before.db");
  after = join(dir, "after.db");
  const store = new SqliteMemoryStore(before);
  const r = new HybridRetriever(store, fake());
  for (let i = 0; i < 30; i++) await r.indexNode(await store.addNode(makeNode({ content: { text: `Memory ${i}: sourdough, sailing, tokyo ${i % 7}` } })));
  store.close();
  copyFileSync(before, after);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const queries = ["sourdough", "sailing tokyo 3", "memory 12"];

describe("the no-loss gate (founder, 2026-09-26: optimization is fine, loss is not)", () => {
  it("an identical copy passes", async () => {
    const r = await compareStores(before, after, { queries, embedder: fake() });
    expect(r).toMatchObject({ lossless: true, contentIdentical: true, lookups: 3, lookupsIdentical: 3 });
  });

  it("a changed word in one memory fails, and names it", async () => {
    const raw = new Database(after);
    const id = (raw.prepare("SELECT node_id FROM memory_nodes LIMIT 1").get() as { node_id: string }).node_id;
    raw.prepare("UPDATE memory_nodes SET content_text = content_text || '!' WHERE node_id = ?").run(id);
    raw.close();
    const r = await compareStores(before, after, { queries, embedder: fake() });
    expect(r.lossless).toBe(false);
    expect(r.contentDiffs).toContain(`changed ${id}`);
  });

  it("the same content with worse search fails too: recall is part of what must not be lost", async () => {
    const raw = new Database(after);
    raw.prepare("DELETE FROM memory_embeddings").run();
    raw.close();
    const r = await compareStores(before, after, { queries, embedder: fake() });
    expect(r.contentIdentical).toBe(true);
    expect(r.lossless).toBe(false);
    expect(r.lookupDiffs.length).toBeGreaterThan(0);
  });
});
