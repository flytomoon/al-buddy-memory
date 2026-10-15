/**
 * The recall fast path (docs/reviews/recall-quality-vs-latency-2026-10.md § 5):
 * the query's keyword search by its content words, keyword lists at a lower
 * weight, a session-diverse order, and vector candidates looked up in batches.
 * The first three are recall options, off by default; the last changes no
 * answer, only how many reads it takes.
 */
import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder } from "./embedder.js";
import { diversified, HybridRetriever, indexMissingEmbeddings, type RecallOptions } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { keywordsOf } from "./query-cues.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "./types/memory.js";

const CONCEPTS: Record<string, number[]> = { tokyo: [1, 0, 0], japan: [0.95, 0.05, 0], london: [0, 1, 0], pasta: [0, 0, 1] };
function conceptEmbedder(): Embedder {
  return new FakeEmbedder("fake-concepts", 3, (text) => {
    const lower = text.toLowerCase();
    const vec = [0.001, 0.001, 0.001];
    for (const [word, axes] of Object.entries(CONCEPTS)) if (lower.includes(word)) for (let i = 0; i < 3; i += 1) vec[i]! += axes[i]!;
    return vec;
  });
}

/** A fact learned at a chosen instant, so recency (the last tie-break) is set by the test. */
async function learned(store: InMemoryStore, input: NewMemoryNode, iso: string): Promise<MemoryNode> {
  const node = { ...(await new InMemoryStore().addNode(input)), temporalAnchors: [{ timestamp: iso, event: "created" as const }], validFrom: input.validFrom ?? iso };
  await store.restoreNode(node);
  return node;
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

describe("recall — diversify", () => {
  /** Four memories of session "a" that match well, then one of session "b" that matches less. */
  async function oneSessionCrowds() {
    const store = new InMemoryStore();
    for (let i = 0; i < 4; i += 1) await learned(store, makeNode({ content: { text: "bread bread bread" }, contextualMetadata: { session: "a" } }), `2023-05-0${i + 1}T10:00:00.000Z`);
    await learned(store, makeNode({ content: { text: "bread and butter on toast for breakfast" }, contextualMetadata: { session: "b" } }), "2023-05-09T10:00:00.000Z");
    return { store, retriever: new HybridRetriever(store) };
  }
  const sessions = (nodes: MemoryNode[]) => nodes.map((n) => n.contextualMetadata["session"]);

  it("puts at most perGroup memories of each session first, then the rest in rank order", async () => {
    const { retriever } = await oneSessionCrowds();
    const plain = await retriever.recall("bread", { limit: 10 });
    expect(sessions(plain)).toEqual(["a", "a", "a", "a", "b"]);
    const diverse = await retriever.recall("bread", { limit: 10, diversify: { by: "session", perGroup: 2 } });
    expect(sessions(diverse)).toEqual(["a", "a", "b", "a", "a"]);
    // A permutation, never a subset: the same memories, the a's in their own order.
    expect(new Set(diverse.map((n) => n.nodeId))).toEqual(new Set(plain.map((n) => n.nodeId)));
    expect(diverse.filter((n) => n.contextualMetadata["session"] === "a").map((n) => n.nodeId)).toEqual(plain.slice(0, 4).map((n) => n.nodeId));
  });

  it("is applied before the limit, so another session's memory can make a short page", async () => {
    const { retriever } = await oneSessionCrowds();
    expect(sessions(await retriever.recall("bread", { limit: 3 }))).toEqual(["a", "a", "a"]);
    expect(sessions(await retriever.recall("bread", { limit: 3, diversify: { by: "session", perGroup: 1 } }))).toEqual(["a", "b", "a"]);
  });

  it("groups a memory without a session by the day it is valid from", async () => {
    const store = new InMemoryStore();
    for (let i = 0; i < 3; i += 1) await learned(store, makeNode({ content: { text: "bread bread bread" } }), `2023-05-01T0${i + 1}:00:00.000Z`);
    const other = await learned(store, makeNode({ content: { text: "bread and butter on toast for breakfast" } }), "2023-05-02T10:00:00.000Z");
    const hits = await new HybridRetriever(store).recall("bread", { limit: 10, diversify: { by: "session", perGroup: 1 } });
    expect(hits.map((n) => n.nodeId).indexOf(other.nodeId)).toBe(1);
  });

  it("a memory a custom grouping leaves out (undefined) is a group of its own", async () => {
    const { retriever } = await oneSessionCrowds();
    const plain = await retriever.recall("bread", { limit: 10 });
    expect(await retriever.recall("bread", { limit: 10, diversify: { by: () => undefined, perGroup: 1 } })).toEqual(plain);
    expect(sessions(await retriever.recall("bread", { limit: 10, diversify: { by: (n) => String(n.contextualMetadata["session"]), perGroup: 3 } }))).toEqual(["a", "a", "a", "b", "a"]);
  });

  it("is off by default, and refuses a cap that is not a positive integer or an unknown key", async () => {
    const { retriever } = await oneSessionCrowds();
    expect(await retriever.recall("bread", { limit: 10, diversify: undefined })).toEqual(await retriever.recall("bread", { limit: 10 }));
    await expect(retriever.recall("bread", { diversify: { by: "session", perGroup: 0 } })).rejects.toThrow(/perGroup must be an integer >= 1/);
    await expect(retriever.recall("bread", { diversify: { by: "session", perGroup: 1.5 } })).rejects.toThrow(/perGroup must be an integer >= 1/);
    await expect(retriever.recall("bread", { diversify: { by: "tags" as "session", perGroup: 2 } })).rejects.toThrow(/diversify.by must be "session" or a function/);
  });

  it("diversified() returns every item exactly once, with the cap honoured at the head", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 50; run += 1) {
      const items = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => ({ i, g: rnd() < 0.2 ? undefined : `g${Math.floor(rnd() * 4)}` }));
      const perGroup = 1 + Math.floor(rnd() * 3);
      const out = diversified(items, (x) => x.g, perGroup);
      expect([...out].sort((a, b) => a.i - b.i)).toEqual(items);
      // The head holds every group's first perGroup in their order; after it, nothing a cap would have let in.
      const head = items.filter((x, k) => x.g === undefined || items.slice(0, k).filter((y) => y.g === x.g).length < perGroup);
      expect(out.slice(0, head.length)).toEqual(head);
    }
  });
});

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

describe("recall — keywordWeight", () => {
  /** One keyword-only find (newer) and one vector-only find (older), one candidate from each list. */
  async function oneOfEach() {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const vector = await learned(store, makeNode({ content: { text: "moved to tokyo" } }), "2020-01-01T00:00:00.000Z");
    const keyword = await learned(store, makeNode({ content: { text: "living with pasta" } }), "2026-01-01T00:00:00.000Z");
    await indexMissingEmbeddings(store, embedder);
    return { keyword, vector, retriever: new HybridRetriever(store, embedder) };
  }
  const q = "living in japan";

  it("at 1 (the default) the lists count the same, and a tie goes to the newer; below 1 the vector find wins", async () => {
    const { keyword, vector, retriever } = await oneOfEach();
    const ids = async (o: RecallOptions) => (await retriever.recall(q, { limit: 5, candidates: 1, ...o })).map((n) => n.nodeId);
    expect(await ids({})).toEqual([keyword.nodeId, vector.nodeId]);
    expect(await ids({ keywordWeight: 1 })).toEqual([keyword.nodeId, vector.nodeId]);
    expect(await ids({ keywordWeight: 0.5 })).toEqual([vector.nodeId, keyword.nodeId]);
    // At 0 a keyword find still comes back, last: weight orders, it never filters.
    expect(await ids({ keywordWeight: 0 })).toEqual([vector.nodeId, keyword.nodeId]);
  });

  it("refuses a weight that is negative or not finite", async () => {
    const { retriever } = await oneOfEach();
    for (const keywordWeight of [-1, Number.NaN, Infinity]) await expect(retriever.recall(q, { keywordWeight })).rejects.toThrow(/keywordWeight must be a finite number >= 0/);
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
