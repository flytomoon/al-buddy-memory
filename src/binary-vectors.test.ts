/**
 * Vectors stored as 32-bit binary instead of JSON text (2026-09-25).
 *
 * Measured on a real 6,819-vector store: the JSON column was 55 MB and every
 * cold recall spent 0.19–0.27 s just parsing it back into numbers. As float32
 * the same vectors are 10.5 MB and decode in about 3 ms. Recall must not change
 * by a single rank: a vector that is not exactly representable in 32 bits
 * stays JSON.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeNode } from "./memory-store-conformance.spec.js";
import { SCHEMA_VERSION, SqliteMemoryStore } from "./sqlite-memory-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "binvec-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What a local embedding model returns: float32 values, carried as JS numbers. */
const float32Vector = (seed: number, n = 384): number[] => Array.from(new Float32Array(Array.from({ length: n }, (_, i) => Math.sin(seed * 1000 + i) / 3)));

const embedding = (nodeId: string, vector: number[]) => ({ nodeId, model: "m", modelVersion: "1", dimensions: vector.length, metric: "cosine" as const, vector });

describe("binary vectors", () => {
  it("a float32 vector is stored as a blob and read back exactly", async () => {
    const path = join(dir, "a.db");
    const store = new SqliteMemoryStore(path);
    const node = await store.addNode(makeNode());
    const v = float32Vector(1);
    await store.setEmbedding(embedding(node.nodeId, v));
    expect((await store.getEmbeddings(node.nodeId))[0]!.vector).toEqual(v);
    expect((await store.listEmbeddings("m"))[0]!.vector).toEqual(v);
    store.close();
    const raw = new Database(path, { readonly: true });
    expect(raw.prepare("SELECT typeof(vector) AS t, length(vector) AS n FROM memory_embeddings").get()).toEqual({ t: "blob", n: 384 * 4 });
    raw.close();
  });

  it("a vector that 32 bits cannot hold exactly stays JSON, so nothing is rounded", async () => {
    const path = join(dir, "b.db");
    const store = new SqliteMemoryStore(path);
    const node = await store.addNode(makeNode());
    const v = [0.1, 0.2, 1 / 3];
    await store.setEmbedding(embedding(node.nodeId, v));
    expect((await store.getEmbeddings(node.nodeId))[0]!.vector).toEqual(v);
    store.close();
    const raw = new Database(path, { readonly: true });
    expect((raw.prepare("SELECT typeof(vector) AS t FROM memory_embeddings").get() as { t: string }).t).toBe("text");
    raw.close();
  });

  it("an older store's JSON vectors are converted on open, to the same numbers", async () => {
    const path = join(dir, "old.db");
    const first = new SqliteMemoryStore(path);
    const a = await first.addNode(makeNode({ content: { text: "a" } }));
    const b = await first.addNode(makeNode({ content: { text: "b" } }));
    first.close();
    const va = float32Vector(2);
    const vb = [0.1, 0.2, 1 / 3];
    const raw = new Database(path);
    const put = raw.prepare("INSERT INTO memory_embeddings (node_id, model, model_version, dimensions, metric, vector, created_at) VALUES (?, 'm', '1', ?, 'cosine', ?, '2026-09-01T00:00:00.000Z')");
    put.run(a.nodeId, va.length, JSON.stringify(va));
    put.run(b.nodeId, vb.length, JSON.stringify(vb));
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.close();

    const reopened = new SqliteMemoryStore(path);
    expect((await reopened.getEmbeddings(a.nodeId))[0]!.vector).toEqual(va);
    expect((await reopened.getEmbeddings(b.nodeId))[0]!.vector).toEqual(vb);
    reopened.close();
    const check = new Database(path, { readonly: true });
    const types = check.prepare("SELECT node_id, typeof(vector) AS t FROM memory_embeddings ORDER BY node_id").all() as { node_id: string; t: string }[];
    expect(Object.fromEntries(types.map((r) => [r.node_id, r.t]))).toEqual({ [a.nodeId]: "blob", [b.nodeId]: "text" });
    expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    check.close();
  });

  it("compact() gives the freed space back to the disk", async () => {
    const path = join(dir, "c.db");
    const store = new SqliteMemoryStore(path);
    for (let i = 0; i < 300; i++) {
      const node = await store.addNode(makeNode({ content: { text: `n${i}` } }));
      await store.setEmbedding(embedding(node.nodeId, float32Vector(i)));
    }
    store.close();
    // Rewrite every vector as JSON, the way an older version stored them, and let the upgrade convert them.
    const raw = new Database(path);
    for (const r of raw.prepare("SELECT node_id, vector FROM memory_embeddings").all() as { node_id: string; vector: Buffer }[]) {
      const f = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.length / 4);
      raw.prepare("UPDATE memory_embeddings SET vector = ? WHERE node_id = ?").run(JSON.stringify(Array.from(f)), r.node_id);
    }
    raw.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    raw.prepare("VACUUM").run();
    raw.close();
    const before = statSync(path).size;
    const upgraded = new SqliteMemoryStore(path);
    upgraded.compact();
    upgraded.close();
    expect(statSync(path).size).toBeLessThan(before / 2);
  });
});
