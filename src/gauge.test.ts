import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEmbedder } from "./embedder.js";
import { checkBudgets, DEFAULT_BUDGETS, gaugeStore, percentile } from "./gauge.js";
import { HybridRetriever } from "./hybrid-retriever.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { recordState } from "./state.js";

/** A small float32 embedding space: enough to exercise the vector path. */
const fake = (): FakeEmbedder =>
  new FakeEmbedder("fake", 8, (t) => Array.from(new Float32Array(Array.from({ length: 8 }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 13) / 13))));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gauge-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function seeded(n: number): Promise<string> {
  const path = join(dir, "g.db");
  const store = new SqliteMemoryStore(path);
  const r = new HybridRetriever(store, fake());
  for (let i = 0; i < n; i++) {
    const node = await store.addNode(makeNode({ content: { text: `Fact ${i} about sourdough and sailing on day ${i}` } }));
    if (i % 10 !== 0) await r.indexNode(node);
  }
  await recordState(store, { subject: "launch", text: "Launched.", at: "2026-09-24T10:00:00.000Z" });
  store.close();
  return path;
}

describe("the gauge (2026-09-26: a measurement with no budget is a fact nobody owns)", () => {
  it("measures size, index health and lookup times of a real store file", async () => {
    const path = await seeded(60);
    const g = await gaugeStore(path, { embedder: fake(), queries: ["sourdough", "sailing day 3"] });
    expect(g).toMatchObject({ memories: 61, liveMemories: 61, vectors: 54, jsonVectors: 0, currentStates: 1, unindexedLive: 7 });
    expect(g.bytesPerVector).toBeGreaterThan(0);
    expect(g.coldRecallMs).not.toBeNull();
    expect(g.warmRecallP95Ms).not.toBeNull();
    expect(g.fileBytes).toBeGreaterThan(0);
  });

  it("without an embedder it still measures everything but meaning search", async () => {
    const g = await gaugeStore(await seeded(10), { queries: ["sourdough"] });
    expect(g.coldRecallMs).toBeNull();
    expect(g.keywordP95Ms).toBeGreaterThanOrEqual(0);
  });

  it("a budget miss becomes a named breach with the reason it matters", async () => {
    const path = await seeded(30);
    const raw = new Database(path);
    raw.prepare("UPDATE memory_embeddings SET vector = '[0.1,0.2,0.3]' WHERE rowid IN (SELECT rowid FROM memory_embeddings LIMIT 2)").run();
    raw.close();
    const g = await gaugeStore(path, { queries: ["sourdough"] });
    const breaches = checkBudgets(g);
    expect(breaches.map((b) => b.metric)).toEqual(expect.arrayContaining(["jsonVectors", "unindexedLive"]));
    expect(breaches.find((b) => b.metric === "jsonVectors")?.why).toMatch(/parsed/);
    expect(checkBudgets({ ...g, jsonVectors: 0, unindexedLive: 0 }, DEFAULT_BUDGETS).map((b) => b.metric)).not.toContain("jsonVectors");
  });

  it("the gauge only reads: the file is unchanged", async () => {
    const path = await seeded(20);
    const before = new Database(path, { readonly: true }).prepare("SELECT count(*) AS n, sum(length(vector)) AS b FROM memory_embeddings").get();
    await gaugeStore(path, { embedder: fake(), queries: ["sourdough"] });
    const after = new Database(path, { readonly: true }).prepare("SELECT count(*) AS n, sum(length(vector)) AS b FROM memory_embeddings").get();
    expect(after).toEqual(before);
  });
});

/**
 * 2026-10-12: the regression gate below failed the steward's `npm run check`
 * with warm recall at 184.5 ms against 120. Each query was timed once, and the
 * "95th percentile" of five timings was the slowest of them, so one pause on a
 * machine running the whole suite decided the number.
 */
describe("one slow moment does not decide a measurement", () => {
  it("percentiles are nearest-rank: the 95th of twenty timings is the 19th, not the slowest", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
    expect(percentile(twenty, 0.95)).toBe(19);
    expect(percentile(twenty, 0.5)).toBe(10);
    expect(percentile(Array.from({ length: 40 }, (_, i) => i + 1), 0.95)).toBe(38);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([], 0.95)).toBe(0);
  });

  it("whichever single timed call hiccups, no reported time shows it", async () => {
    const path = await seeded(10);
    const opts = { embedder: fake(), queries: ["sourdough", "sailing day 3"] };
    let reads = 0;
    await gaugeStore(path, { ...opts, clock: () => reads++ });
    // Every timed call reads the clock twice, start and end.
    expect(reads % 2).toBe(0);
    const timed = reads / 2;
    expect(timed).toBeGreaterThan(0);
    for (let slow = 0; slow < timed; slow++) {
      // 1 ms a call, except call `slow`, which takes a second.
      let r = 0;
      const clock = () => {
        const at = r++;
        return at + (at >= 2 * slow + 1 ? 1000 : 0);
      };
      const g = await gaugeStore(path, { ...opts, clock });
      expect([g.coldRecallMs, g.warmRecallP50Ms, g.warmRecallP95Ms, g.keywordP50Ms, g.keywordP95Ms, g.statesMs], `timed call ${slow} of ${timed} took a second`).toEqual([1, 1, 1, 1, 1, 1]);
    }
  }, 60_000);

  it("with nothing to look up, it reports no lookup times and still returns", async () => {
    const path = join(dir, "empty.db");
    new SqliteMemoryStore(path).close();
    const g = await gaugeStore(path, { embedder: fake() });
    expect(g).toMatchObject({ memories: 0, coldRecallMs: null, warmRecallP50Ms: null, warmRecallP95Ms: null, keywordP50Ms: 0, keywordP95Ms: 0 });
    expect(g.statesMs).toBeGreaterThanOrEqual(0);
    const none = await gaugeStore(await seeded(5), { embedder: fake(), queries: [] });
    expect(none).toMatchObject({ coldRecallMs: null, warmRecallP95Ms: null, keywordP95Ms: 0 });
  });
});

describe("the store stays inside its budgets (regression gate)", () => {
  it("3,000 memories with 384-wide vectors meet every size and speed budget", async () => {
    const path = join(dir, "budget.db");
    const store = new SqliteMemoryStore(path);
    const wide = new FakeEmbedder("wide", 384, (t) => {
      let s = 0;
      for (let i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) >>> 0;
      return Array.from(new Float32Array(Array.from({ length: 384 }, () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5)));
    });
    const r = new HybridRetriever(store, wide);
    for (let i = 0; i < 3000; i++) await r.indexNode(await store.addNode(makeNode({ content: { text: `Fact ${i}: likes sourdough and sailing, day ${i % 365}` } })));
    store.close();
    const g = await gaugeStore(path, { embedder: wide, queries: ["sourdough", "sailing day 42", "fact 1200", "likes", "day 7"] });
    expect(g.bytesPerVector).toBe(1536);
    expect(checkBudgets(g)).toEqual([]);
  }, 60_000);
});
