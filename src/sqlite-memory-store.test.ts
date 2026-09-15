import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

describe("SqliteMemoryStore — a store written before 0.4.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-buddy-memmigrate-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rewrites validity bounds to one canonical spelling on open, and leaves what it cannot parse", async () => {
    const dbPath = join(dir, "old.db");
    const first = new SqliteMemoryStore(dbPath);
    const a = await first.addNode(makeNode({ content: { text: "a" } }));
    const b = await first.addNode(makeNode({ content: { text: "b" } }));
    first.close();

    // What an older version happily stored: no milliseconds, an offset, junk.
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE memory_nodes SET valid_from = ?, valid_to = ? WHERE node_id = ?`).run("2026-01-01T00:00:00Z", "2030-01-01T00:00:00-09:00", a.nodeId);
    raw.prepare(`UPDATE memory_nodes SET valid_from = ? WHERE node_id = ?`).run("sometime", b.nodeId);
    raw.pragma("user_version = 4");
    raw.close();

    const reopened = new SqliteMemoryStore(dbPath);
    try {
      const fixed = await reopened.getNode(a.nodeId);
      expect(fixed?.validFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(fixed?.validTo).toBe("2030-01-01T09:00:00.000Z");
      expect((await reopened.getNode(b.nodeId))?.validFrom).toBe("sometime");
    } finally {
      reopened.close();
    }
    const check = new Database(dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(6); // every migration ran, v6 included
    check.close();
  });
});

describe("SqliteMemoryStore — re-importing over a store written before 0.4.0", () => {
  it("accepts a newer copy whose anchors differ from the stored ones only in spelling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-memanchors-"));
    const dbPath = join(dir, "old.db");
    try {
      const store = new SqliteMemoryStore(dbPath);
      const node = await store.addNode(makeNode({ content: { text: "imported long ago" } }));
      store.close();
      // 0.3.x stored anchors verbatim, so a foreign writer's "…00Z" could sit here.
      const raw = new Database(dbPath);
      raw.prepare(`UPDATE memory_nodes SET temporal_anchors = ? WHERE node_id = ?`).run(JSON.stringify([{ timestamp: "2025-01-01T00:00:00Z", event: "created" }]), node.nodeId);
      raw.close();

      const reopened = new SqliteMemoryStore(dbPath);
      const newer = { ...node, confidenceWeight: 0.4, temporalAnchors: [{ timestamp: "2025-01-01T00:00:00.000Z", event: "created" as const }, { timestamp: "2026-01-01T00:00:00.000Z", event: "modified" as const }] };
      await expect(reopened.restoreNode(newer)).resolves.toBeUndefined();
      expect((await reopened.getNode(node.nodeId))?.confidenceWeight).toBe(0.4);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Astra final review, 2026-09-15 (B3): 0.3.3's restoreNode stored creation times
 * verbatim, offsets included. SQL ordered those strings byte-wise, JavaScript
 * with localeCompare, and neither by the instant — so on such a store the limited
 * read and the unlimited read disagreed about the first fact. Astra's fixture.
 */
describe("SqliteMemoryStore — paging over creation times written before 0.4.0", () => {
  it("orders by the instant in SQL and JS alike, so the page is still the first of the full read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "al-buddy-memlegacy-"));
    const dbPath = join(dir, "legacy.db");
    try {
      const first = new SqliteMemoryStore(dbPath);
      const id = (i: number) => `00000000-0000-4000-8000-000000000${String(i).padStart(3, "0")}`;
      for (let i = 0; i <= 200; i++) {
        await first.restoreNode({
          ...makeNode({ content: { text: "needle" }, confidenceWeight: 0.5, decayRate: 0 }),
          nodeId: id(i),
          temporalAnchors: [{ timestamp: "2026-01-01T00:00:00.000Z", event: "created" }],
          validFrom: "2025-01-01T00:00:00.000Z",
          validTo: null,
        });
      }
      first.close();
      // What 0.3.3 would have stored: rows 000–199 at 01:00Z spelled with -01:00,
      // row 200 at 23:00Z the day before spelled with +01:00 (older, but "+" sorts first).
      const raw = new Database(dbPath);
      const set = raw.prepare(`UPDATE memory_nodes SET created_at = ?, temporal_anchors = ? WHERE node_id = ?`);
      for (let i = 0; i <= 200; i++) {
        const at = i === 200 ? "2026-01-01T00:00:00+01:00" : "2026-01-01T00:00:00-01:00";
        set.run(at, JSON.stringify([{ timestamp: at, event: "created" }]), id(i));
      }
      raw.pragma("user_version = 5");
      raw.close();

      const store = new SqliteMemoryStore(dbPath);
      for (const query of [undefined, "needle"]) {
        const all = await store.searchNodes(query === undefined ? {} : { query });
        const page = await store.searchNodes(query === undefined ? { limit: 1 } : { query, limit: 1 });
        // newest by instant is one of 000–199; among those, the largest id
        expect(all[0]?.nodeId).toBe(id(199));
        expect(page.map((n) => n.nodeId)).toEqual([id(199)]);
        expect(all.at(-1)?.nodeId).toBe(id(200));
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
