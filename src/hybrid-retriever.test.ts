import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder, cosineSimilarity } from "./embedder.js";
import { HybridRetriever, indexMissingEmbeddings } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";

/**
 * FakeEmbedder maps known concept words onto fixed axes so tests can create
 * semantic neighbors that share no tokens (the case FTS can't retrieve).
 */
const CONCEPTS: Record<string, number[]> = {
  tokyo: [1, 0, 0],
  japan: [0.95, 0.05, 0],
  london: [0, 1, 0],
  pasta: [0, 0, 1],
};

function conceptEmbedder(): Embedder {
  return new FakeEmbedder("fake-concepts", 3, (text) => {
    const lower = text.toLowerCase();
    const vec = [0.001, 0.001, 0.001];
    for (const [word, axes] of Object.entries(CONCEPTS)) {
      if (lower.includes(word)) for (let i = 0; i < 3; i += 1) vec[i]! += axes[i]!;
    }
    return vec;
  });
}

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and ~0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 3])).toBeCloseTo(0);
  });
});

describe("indexMissingEmbeddings", () => {
  it("embeds nodes that lack a vector for the embedder's model and skips ones that have it", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const a = await store.addNode(makeNode({ content: { text: "tokyo" } }));
    const b = await store.addNode(makeNode({ content: { text: "pasta" } }));
    await store.setEmbedding({
      nodeId: a.nodeId,
      model: embedder.model,
      modelVersion: "1",
      dimensions: 3,
      metric: "cosine",
      vector: [1, 0, 0],
    });

    const indexed = await indexMissingEmbeddings(store, embedder);
    expect(indexed).toBe(1); // only b
    expect(await store.getEmbeddings(b.nodeId)).toHaveLength(1);
  });
});

describe("HybridRetriever", () => {
  it("finds semantic neighbors that share no keywords with the query", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    await store.addNode(makeNode({ content: { text: "moved to japan last spring" } }));
    await store.addNode(makeNode({ content: { text: "loves cooking pasta" } }));
    await indexMissingEmbeddings(store, embedder);

    const retriever = new HybridRetriever(store, embedder);
    // "tokyo" shares no tokens with either node; only the vector space links it to japan.
    const results = await retriever.recall("tokyo", { limit: 1 });
    expect(results).toHaveLength(1);
    expect(results[0]?.content.text).toContain("japan");
  });

  it("still works keyword-only without an embedder", async () => {
    const store = new InMemoryStore();
    await store.addNode(makeNode({ content: { text: "likes london fog" } }));
    const retriever = new HybridRetriever(store);
    const results = await retriever.recall("london", { limit: 3 });
    expect(results[0]?.content.text).toContain("london");
  });

  it("excludes superseded nodes by default", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const old = await store.addNode(makeNode({ content: { text: "lives in london" } }));
    await store.addNode(makeNode({ content: { text: "lives in tokyo japan" } }));
    await store.updateNode(old.nodeId, { validTo: new Date().toISOString() });
    await indexMissingEmbeddings(store, embedder);

    const retriever = new HybridRetriever(store, embedder);
    const results = await retriever.recall("london", { limit: 5 });
    expect(results.map((n) => n.content.text)).not.toContain("lives in london");
  });

  it("fuses keyword and vector rankings (a hit in both lists wins)", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    await store.addNode(makeNode({ content: { text: "tokyo apartment hunting" } })); // both lists
    await store.addNode(makeNode({ content: { text: "visited japan once" } })); // vector only
    await store.addNode(makeNode({ content: { text: "tokyo drift movie review, mostly about cars and pasta" } }));
    await indexMissingEmbeddings(store, embedder);

    const retriever = new HybridRetriever(store, embedder);
    const results = await retriever.recall("tokyo", { limit: 3 });
    expect(results[0]?.content.text).toBe("tokyo apartment hunting");
  });
});

describe("HybridRetriever.indexNode", () => {
  it("embeds a single node so it is immediately vector-searchable", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const retriever = new HybridRetriever(store, embedder);
    const node = await store.addNode(makeNode({ content: { text: "visited japan" } }));

    await retriever.indexNode(node);

    expect(await store.getEmbeddings(node.nodeId)).toHaveLength(1);
    const results = await retriever.recall("tokyo", { limit: 1 });
    expect(results[0]?.nodeId).toBe(node.nodeId);
  });

  it("is a no-op without an embedder", async () => {
    const store = new InMemoryStore();
    const retriever = new HybridRetriever(store);
    const node = await store.addNode(makeNode());
    await retriever.indexNode(node); // must not throw
    expect(await store.getEmbeddings(node.nodeId)).toHaveLength(0);
  });
});

describe("HybridRetriever.findDuplicate + reinforce", () => {
  it("reinforces an existing near-duplicate instead of reporting none", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const existing = await store.addNode(
      makeNode({ content: { text: "lives in tokyo" }, confidenceWeight: 0.8 }),
    );
    await indexMissingEmbeddings(store, embedder);

    const retriever = new HybridRetriever(store, embedder);
    const dup = await retriever.findDuplicate("resides in tokyo japan");
    expect(dup?.nodeId).toBe(existing.nodeId);

    const reinforced = await retriever.reinforce(existing.nodeId);
    expect(reinforced.confidenceWeight).toBeGreaterThan(0.8);
    expect(reinforced.confidenceWeight).toBeLessThanOrEqual(1);
    expect(reinforced.temporalAnchors.at(-1)?.event).toBe("reinforced");
  });

  it("returns no duplicate for genuinely new facts", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    await store.addNode(makeNode({ content: { text: "lives in tokyo" } }));
    await indexMissingEmbeddings(store, embedder);

    const retriever = new HybridRetriever(store, embedder);
    expect(await retriever.findDuplicate("loves cooking pasta")).toBeUndefined();
  });

  it("returns no duplicate when there is no embedder (never false-positives on keywords)", async () => {
    const store = new InMemoryStore();
    await store.addNode(makeNode({ content: { text: "lives in tokyo" } }));
    const retriever = new HybridRetriever(store);
    expect(await retriever.findDuplicate("lives in tokyo")).toBeUndefined();
  });
});
