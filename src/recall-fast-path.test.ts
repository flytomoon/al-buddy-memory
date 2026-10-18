/**
 * The recall fast path (#1003): vector candidates looked up in batches,
 * which changes no answer, only how many reads it takes.
 */
import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { HybridRetriever, indexMissingEmbeddings, type RecallOptions } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
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

describe("recall — a tie group too big to spread", () => {
  it("reads 300k tied candidates in one lookup without overflowing the stack", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const real = await store.addNode(makeNode({ content: { text: "tokyo" } }));
    const [vector] = await embedder.embed(["tokyo"]);
    // One real fact and 300k vectors that tie it but name nothing: once the pool
    // of one is full, the rest of the tie group is one `getNodes` call.
    const rows = [real.nodeId, ...Array.from({ length: 300_000 }, (_, i) => `ghost-${i}`)].map((nodeId) => ({ nodeId, modelVersion: embedder.modelVersion, dimensions: embedder.dimensions, vector: vector! }));
    const batches: number[] = [];
    const stub = new Proxy(store, {
      get(target, prop) {
        if (prop === "listEmbeddingVectors") return async () => rows;
        if (prop === "getNodes") return async (ids: readonly string[]) => (batches.push(ids.length), target.getNodes(ids));
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const hits = await new HybridRetriever(stub, embedder).recall("tokyo", { limit: 5, candidates: 1 });
    expect(hits.map((n) => n.nodeId)).toEqual([real.nodeId]);
    expect(Math.max(...batches)).toBeGreaterThan(200_000);
  });
});
