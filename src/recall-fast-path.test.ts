/**
 * The recall fast path (docs/reviews/recall-quality-vs-latency-2026-10.md § 5
 * and § 8): the query's keyword search by its content words, a recall option
 * off by default, and vector candidates looked up in batches, which changes no
 * answer, only how many reads it takes.
 */
import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { HybridRetriever, indexMissingEmbeddings, type RecallOptions } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { keywordsOf } from "./query-cues.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

const CONCEPTS: Record<string, number[]> = { tokyo: [1, 0, 0], japan: [0.95, 0.05, 0], london: [0, 1, 0], pasta: [0, 0, 1] };
function conceptEmbedder(): Embedder {
  return new FakeEmbedder("fake-concepts", 3, (text) => {
    const lower = text.toLowerCase();
    const vec = [0.001, 0.001, 0.001];
    for (const [word, axes] of Object.entries(CONCEPTS)) if (lower.includes(word)) for (let i = 0; i < 3; i += 1) vec[i]! += axes[i]!;
    return vec;
  });
}

/** The same store, minus `getNodes`: recall then looks candidates up one by one, as before. */
function withoutGetNodes(store: MemoryStore): MemoryStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "getNodes") return undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("recall — contentWords", () => {
  async function noisy() {
    const store = new InMemoryStore();
    const chores = await store.addNode(makeNode({ content: { text: "I did the dishes and then I did the laundry" } }));
    const bikes = await store.addNode(makeNode({ content: { text: "bikes need new tyres" } }));
    return { store, chores, bikes, retriever: new HybridRetriever(store) };
  }

  it("searches the query's keyword list by what it is about, not by its question words", async () => {
    const { chores, bikes, retriever } = await noisy();
    const q = "What did I do with the bikes?";
    expect((await retriever.recall(q, { limit: 5 })).map((n) => n.nodeId).sort()).toEqual([chores.nodeId, bikes.nodeId].sort());
    expect((await retriever.recall(q, { limit: 5, contentWords: true })).map((n) => n.nodeId)).toEqual([bikes.nodeId]);
  });

  it("a query of nothing but question words is searched as written, so it still finds something", async () => {
    const { chores, retriever } = await noisy();
    expect(keywordsOf("What did I do?")).toBe("");
    expect((await retriever.recall("What did I do?", { limit: 5, contentWords: true })).map((n) => n.nodeId)).toEqual([chores.nodeId]);
  });

  it("is off by default", async () => {
    const { retriever } = await noisy();
    const q = "What did I do with the bikes?";
    expect(await retriever.recall(q, { limit: 5, contentWords: false })).toEqual(await retriever.recall(q, { limit: 5 }));
  });

  it("with expand, a long question's content-word search is its own search, not a second copy of it", async () => {
    const { store } = await noisy();
    const queries: string[] = [];
    const counting = new Proxy(store, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "searchNodes") return (o: { query?: string }) => (queries.push(o.query ?? ""), target.searchNodes(o));
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const retriever = new HybridRetriever(counting);
    const long = "Can you remind me what it was that I said I wanted to do with the old bikes in the garage?";
    expect(long.split(/\s+/).length).toBeGreaterThan(16);
    await retriever.recall(long, { expand: { now: "2023-05-30T00:00:00.000Z" } });
    expect(queries).toEqual([long, keywordsOf(long)]);
    queries.length = 0;
    await retriever.recall(long, { expand: { now: "2023-05-30T00:00:00.000Z" }, contentWords: true });
    expect(queries).toEqual([keywordsOf(long)]);
  });
});

const STORES: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

describe.each(STORES)("recall — vector candidates looked up in batches (%s)", (_label, makeStore) => {
  /** Ties at every similarity, three memory types, a retired fact: every rule of the walk has work to do. */
  async function busy() {
    const store = makeStore();
    const texts = ["visited japan", "visited japan", "tokyo trip", "london calling", "pasta night", "japan and pasta"];
    for (let i = 0; i < 60; i += 1) {
      await store.addNode(
        makeNode({
          content: { text: texts[i % texts.length]! },
          memoryType: (["Experience", "Lesson", "Conversation"] as const)[i % 3],
          confidenceWeight: [1, 0.9, 0.5][i % 3]!,
          ...(i % 11 === 0 ? { validTo: "2020-01-01T00:00:00.000Z" } : {}),
        }),
      );
    }
    await indexMissingEmbeddings(store, conceptEmbedder());
    return store;
  }

  it("recalls exactly what one-by-one lookups recall, with scopes and ties at the cut", async () => {
    const store = await busy();
    const batched = new HybridRetriever(store, conceptEmbedder());
    const single = new HybridRetriever(withoutGetNodes(store), conceptEmbedder());
    const cases: RecallOptions[] = [{}, { limit: 100 }, { limit: 100, candidates: 1 }, { limit: 100, candidates: 3 }, { limit: 100, memoryType: "Lesson" }, { limit: 20, memoryType: ["Conversation"], candidates: 2 }, { limit: 100, minConfidence: 0.9 }];
    for (const query of ["japan", "tokyo", "pasta", "nothing like it"]) {
      for (const options of cases) expect(await batched.recall(query, options), `${query} ${JSON.stringify(options)}`).toEqual(await single.recall(query, options));
    }
    for (const text of ["japan", "visited japan", "pasta"]) expect(await batched.findDuplicate(text)).toEqual(await single.findDuplicate(text));
  });

  it("reads the candidates in one call, not one per candidate", async () => {
    const store = await busy();
    const calls = { getNode: 0, getNodes: 0 };
    const counted = new Proxy(store, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (typeof value !== "function") return value;
        const fn = (value as (...a: unknown[]) => unknown).bind(target);
        return prop === "getNode" || prop === "getNodes" ? (...a: unknown[]) => ((calls[prop] += 1), fn(...a)) : fn;
      },
    });
    await new HybridRetriever(counted, conceptEmbedder()).recall("london", { limit: 10, candidates: 5 });
    expect(calls.getNode).toBe(0);
    // The pool's worth, then the tie group at its edge: 10 copies of "london calling" tie at five.
    expect(calls.getNodes).toBeGreaterThanOrEqual(1);
    expect(calls.getNodes).toBeLessThanOrEqual(2);
  });
});
