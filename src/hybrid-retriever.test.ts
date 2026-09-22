import { describe, expect, it } from "vitest";
import type { Embedder } from "./embedder.js";
import { FakeEmbedder, cosineSimilarity } from "./embedder.js";
import { HybridRetriever, indexMissingEmbeddings } from "./hybrid-retriever.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import type { MemoryNode } from "./types/memory.js";

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
      // This embedder's own version: a row from any other version is not a
      // vector this embedder can use, and the backfill replaces it.
      modelVersion: embedder.modelVersion,
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

describe("HybridRetriever scoped recall", () => {
  async function seeded() {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    await store.addNode(makeNode({ content: { text: "his own words: japan trip" }, contextualMetadata: { tags: ["voice"] } }));
    await store.addNode(makeNode({ content: { text: "a news item about tokyo" }, contextualMetadata: { tags: ["news"] } }));
    await store.addNode(makeNode({ content: { text: "tokyo tokyo tokyo schedule" }, memoryType: "Skill" }));
    await indexMissingEmbeddings(store, embedder);
    return { store, retriever: new HybridRetriever(store, embedder) };
  }

  it("keeps out-of-scope facts off BOTH the keyword and the vector list", async () => {
    const { retriever } = await seeded();
    // "tokyo" hits the news item and the Skill fact by keyword, and all three by vector.
    const voice = await retriever.recall("tokyo", { limit: 5, tags: ["voice"] });
    expect(voice.map((n) => n.content.text)).toEqual(["his own words: japan trip"]);
  });

  it("scopes by memory type and minimum confidence", async () => {
    const { store, retriever } = await seeded();
    const tasks = await retriever.recall("tokyo", { limit: 5, memoryType: "Skill" });
    expect(tasks.map((n) => n.content.text)).toEqual(["tokyo tokyo tokyo schedule"]);
    await store.addNode(makeNode({ content: { text: "unsure: tokyo maybe" }, confidenceWeight: 0.1 }));
    const confident = await retriever.recall("tokyo", { limit: 10, minConfidence: 0.5 });
    expect(confident.map((n) => n.content.text)).not.toContain("unsure: tokyo maybe");
  });

  it("finds an in-scope neighbour even when the nearest vectors are all out of scope", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    for (let i = 0; i < 60; i++) {
      await store.addNode(makeNode({ content: { text: `tokyo note ${i}` }, contextualMetadata: { tags: ["news"] } }));
    }
    await store.addNode(makeNode({ content: { text: "japan, in his words" }, contextualMetadata: { tags: ["voice"] } }));
    await indexMissingEmbeddings(store, embedder);
    const retriever = new HybridRetriever(store, embedder);
    const hits = await retriever.recall("tokyo", { limit: 3, tags: ["voice"] });
    expect(hits.map((n) => n.content.text)).toEqual(["japan, in his words"]);
  });

  it("never lets Archived or PendingDeletion facts in through the vector side", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const retriever = new HybridRetriever(store, embedder);
    // Embedded at capture (indexNode), archived later: the real path by which an
    // archived fact still has a vector.
    for (const [text, tier] of [["japan, archived", "Archived"], ["japan, being deleted", "PendingDeletion"], ["japan, current", "FullRetention"]] as const) {
      const node = await store.addNode(makeNode({ content: { text } }));
      await retriever.indexNode(node);
      if (tier !== "FullRetention") await store.updateNode(node.nodeId, { retentionTier: tier });
    }
    const hits = await retriever.recall("tokyo", { limit: 5 });
    expect(hits.map((n) => n.content.text)).toEqual(["japan, current"]);
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

/**
 * Reported from outside (2026-09-14): a limited read that ties returns the
 * OLDEST n. The store half of that is covered in the conformance suite; this is
 * the fusion half, where a tie is not a corner case but the normal shape of
 * reciprocal-rank fusion — one fact wins the keyword list, the other wins the
 * vector list, and 1/61 + 1/62 is the same number both ways.
 */
describe("HybridRetriever ties", () => {
  /** A fact learned at a chosen instant: built elsewhere, restored with that creation anchor. */
  const learnedAt = async (store: InMemoryStore, text: string, iso: string): Promise<MemoryNode> => {
    const node = { ...(await new InMemoryStore().addNode(makeNode({ content: { text } }))), temporalAnchors: [{ timestamp: iso, event: "created" as const }] };
    await store.restoreNode(node);
    return node;
  };

  async function tied(olderText: string, newerText: string) {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    // "tokyo tokyo pasta" wins the keyword list (term frequency) and loses the
    // vector list; "tokyo japan trip notes" the other way round.
    const older = await learnedAt(store, olderText, "2020-01-01T00:00:00.000Z");
    const newer = await learnedAt(store, newerText, "2026-09-14T00:00:00.000Z");
    await indexMissingEmbeddings(store, embedder);
    const hits = await new HybridRetriever(store, embedder).recall("tokyo", { limit: 1 });
    return { hits, older, newer };
  }

  it("returns the most recently learned of two facts that fuse to the same score", async () => {
    const a = await tied("tokyo tokyo pasta", "tokyo japan trip notes");
    expect(a.hits.map((n) => n.nodeId)).toEqual([a.newer.nodeId]);

    // The same pair with the ages swapped: still the newest, so it is recency
    // deciding and not insertion order or which list the winner came from.
    const b = await tied("tokyo japan trip notes", "tokyo tokyo pasta");
    expect(b.hits.map((n) => n.nodeId)).toEqual([b.newer.nodeId]);
  });
});

/** Review 2026-09-14 (Astra A3/A5/A6): three ways the vector side still ranked wrongly. */
describe("HybridRetriever ranks the vector side the way the stores rank", () => {
  const OLD_ID = "00000000-0000-4000-8000-000000000001";
  const NEW_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const factAt = (nodeId: string, text: string, iso: string, extra: Partial<Parameters<typeof makeNode>[0]> = {}): MemoryNode => ({
    ...makeNode({ content: { text }, ...extra }),
    nodeId,
    temporalAnchors: [{ timestamp: iso, event: "created" }],
    validFrom: iso,
    validTo: null,
  });

  it("two equally similar facts: the newest wins, even when the old one has the smaller id", async () => {
    // The 0.3.5 comment said "recency settles it once the nodes are loaded
    // below". Nothing below did; the smaller id won, and with 50 smaller-id
    // copies the newest fact never made the pool at all.
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    await store.restoreNode(factAt(OLD_ID, "visited japan", "2020-01-01T00:00:00.000Z"));
    await store.restoreNode(factAt(NEW_ID, "visited japan", "2026-09-01T00:00:00.000Z"));
    await indexMissingEmbeddings(store, embedder);
    const retriever = new HybridRetriever(store, embedder);
    expect((await retriever.recall("tokyo", { limit: 1 }))[0]?.nodeId).toBe(NEW_ID);
    expect((await retriever.findDuplicate("japan"))?.nodeId).toBe(NEW_ID);
  });

  it("a vector of the wrong length is skipped, not scored NaN into a scrambled order", async () => {
    for (const order of ["bad-first", "good-first"]) {
      const store = new InMemoryStore();
      const embedder = conceptEmbedder();
      const good = await store.addNode(makeNode({ content: { text: "tokyo" } }));
      const bad = await store.addNode(makeNode({ content: { text: "tokyo too" } }));
      // Both rows claim this embedder's model AND version, so the length check
      // is the only thing that can save the order — which is the point here.
      const put = {
        good: () => store.setEmbedding({ nodeId: good.nodeId, model: embedder.model, modelVersion: embedder.modelVersion, dimensions: 3, metric: "cosine", vector: [1, 0, 0] }),
        bad: () => store.setEmbedding({ nodeId: bad.nodeId, model: embedder.model, modelVersion: embedder.modelVersion, dimensions: 3, metric: "cosine", vector: [1, 0] }),
      };
      if (order === "bad-first") await put.bad().then(put.good);
      else await put.good().then(put.bad);
      const retriever = new HybridRetriever(store, embedder);
      expect((await retriever.findDuplicate("tokyo"))?.nodeId).toBe(good.nodeId);
    }
  });

  it("a fused tie goes to the higher EFFECTIVE confidence, not the stored one", async () => {
    const store = new InMemoryStore();
    const embedder = conceptEmbedder();
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    // Keyword winner, stored 0.9 but decaying hard: effective 0.45. Newer, too —
    // so recency cannot be what picks the other one.
    const fading = factAt(NEW_ID, "tokyo tokyo pasta", twoDaysAgo, { confidenceWeight: 0.9, decayRate: 1 });
    // Vector winner, stored 0.8, never decays.
    const steady = factAt(OLD_ID, "tokyo japan trip notes", "2020-01-01T00:00:00.000Z", { confidenceWeight: 0.8, decayRate: 0 });
    await store.restoreNode(fading);
    await store.restoreNode(steady);
    await indexMissingEmbeddings(store, embedder);
    const hits = await new HybridRetriever(store, embedder).recall("tokyo", { limit: 1 });
    expect(hits[0]?.nodeId).toBe(OLD_ID);
  });
});

/**
 * A vector cache is only disposable if the library can tell when it is stale.
 * The vectors are tagged with the model's NAME, and a provider that ships new
 * weights under the same name puts a different vector space behind the same
 * tag: the retriever went on comparing the old vectors, and the backfill
 * reported nothing to do. The tag that matters is (model, modelVersion,
 * dimensions) (Astra R9, 2026-09-18).
 */
describe("HybridRetriever — a model whose weights changed under the same name", () => {
  it("neither compares nor keeps the vectors from the version before", async () => {
    const store = new InMemoryStore();
    const flat = await store.addNode(makeNode({ content: { text: "the flat in shibuya" } }));
    // Both versions answer every text with the same vector, so nothing but the
    // version tag can distinguish them.
    const v1 = new FakeEmbedder("m", 2, () => [1, 0]);
    expect(await indexMissingEmbeddings(store, v1)).toBe(1);

    const v2 = new FakeEmbedder("m", 2, () => [1, 0], "2");
    // "japan" is in no fact's text, so a hit can only come from a vector — and
    // the only vectors in the store belong to a model that no longer exists.
    expect(await new HybridRetriever(store, v2).recall("japan", { limit: 5 })).toEqual([]);

    expect(await indexMissingEmbeddings(store, v2)).toBe(1);
    expect((await store.getEmbeddings(flat.nodeId)).map((e) => e.modelVersion)).toEqual(["2"]);
    expect((await new HybridRetriever(store, v2).recall("japan", { limit: 5 })).map((n) => n.nodeId)).toEqual([flat.nodeId]);
  });
});

describe("indexMissingEmbeddings — every tier (review 2026-09-22)", () => {
  /** It read the active tiers only, so an Archived fact was never embedded and a scoped vector recall for Archived could not see it. */
  it("embeds Archived and PendingDeletion facts, as well as retired and Sealed ones", async () => {
    const store = new InMemoryStore();
    const archived = await store.addNode(makeNode({ retentionTier: "Archived", content: { text: "old archived fact" } }));
    const pending = await store.addNode(makeNode({ retentionTier: "PendingDeletion", content: { text: "binned fact" } }));
    const sealed = await store.addNode(makeNode({ privacyClassification: "Sealed", content: { text: "sealed fact" } }));
    const retired = await store.addNode(makeNode({ validTo: "2020-01-01T00:00:00.000Z", content: { text: "retired fact" } }));
    const embedder = new FakeEmbedder("f", 2, () => [1, 0]);
    expect(await indexMissingEmbeddings(store, embedder)).toBe(4);
    expect(new Set((await store.listEmbeddings("f")).map((e) => e.nodeId))).toEqual(new Set([archived.nodeId, pending.nodeId, sealed.nodeId, retired.nodeId]));
  });
});
