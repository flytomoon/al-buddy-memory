import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { learnedAt } from "./decay.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "./types/memory.js";

/**
 * Behavioral conformance suite shared by every {@link MemoryStore}
 * implementation (in-memory, SQLite, and any future backend). This file is
 * `.spec.ts` on purpose: the tsc build excludes it and vitest only auto-collects
 * `*.test.ts`, so it is a plain importable module — each backend's `*.test.ts`
 * calls {@link runMemoryStoreConformance} to register the suite against itself.
 */

/** Build a valid {@link NewMemoryNode} with sensible defaults for tests. */
export function makeNode(overrides: Partial<NewMemoryNode> = {}): NewMemoryNode {
  return {
    provenance: "UserInput",
    encryptionKeyRef: "test-key",
    memoryType: "Experience",
    privacyClassification: "Private",
    retentionTier: "FullRetention",
    content: { text: "a thing happened" },
    contextualMetadata: {},
    confidenceWeight: 1.0,
    decayRate: 0.0,
    ...overrides,
  };
}

/**
 * Register the shared behavioral suite against a store implementation.
 *
 * @param label      display name for the `describe` block
 * @param makeStore  fresh store per test (constructed in `beforeEach`)
 */
export function runMemoryStoreConformance(label: string, makeStore: () => MemoryStore): void {
  describe(`${label} — MemoryStore conformance`, () => {
    let store: MemoryStore;

    beforeEach(() => {
      store = makeStore();
    });

    afterEach(() => {
      (store as { close?: () => void }).close?.();
    });

    // --- Nodes ------------------------------------------------------------

    it("assigns a nodeId and a 'created' temporal anchor", async () => {
      const node = await store.addNode(makeNode());
      expect(node.nodeId).toBeTruthy();
      expect(node.temporalAnchors).toHaveLength(1);
      expect(node.temporalAnchors[0]?.event).toBe("created");
    });

    it("stores and retrieves a node by id", async () => {
      const added = await store.addNode(makeNode({ content: { text: "met Alice" } }));
      const found = await store.getNode(added.nodeId);
      expect(found?.content.text).toBe("met Alice");
    });

    it("returns undefined for an unknown node id", async () => {
      expect(await store.getNode("does-not-exist")).toBeUndefined();
    });

    // --- Bi-temporal valid-time ------------------------------------------

    it("defaults validFrom to creation time and validTo to null (open)", async () => {
      const node = await store.addNode(makeNode());
      expect(node.validTo).toBeNull();
      expect(node.validFrom).toBe(node.temporalAnchors[0]?.timestamp);
    });

    it("respects explicit valid-time for facts true before they were recorded", async () => {
      const node = await store.addNode(
        makeNode({ validFrom: "2020-01-01T00:00:00.000Z", validTo: null }),
      );
      expect(node.validFrom).toBe("2020-01-01T00:00:00.000Z");
    });

    it("supersedes a fact by setting validTo instead of deleting it", async () => {
      // The fact was true from 2018 (before we ever recorded it).
      const london = await store.addNode(
        makeNode({ content: { text: "lives in London" }, validFrom: "2018-01-01T00:00:00.000Z" }),
      );

      // Move to Tokyo: close the old fact's validity window, don't delete it.
      const superseded = await store.updateNode(london.nodeId, {
        validTo: "2022-06-01T00:00:00.000Z",
      });
      expect(superseded.validTo).toBe("2022-06-01T00:00:00.000Z");

      // The node still exists — history is preserved.
      expect(await store.getNode(london.nodeId)).toBeDefined();

      // But a validAt query after the move excludes it.
      const nowValid = await store.searchNodes({ validAt: "2023-01-01T00:00:00.000Z" });
      expect(nowValid.find((n) => n.nodeId === london.nodeId)).toBeUndefined();

      // ...while a validAt query during the window still finds it.
      const thenValid = await store.searchNodes({ validAt: "2021-01-01T00:00:00.000Z" });
      expect(thenValid.find((n) => n.nodeId === london.nodeId)).toBeDefined();
    });

    it("excludes not-yet-valid nodes from a validAt query", async () => {
      const future = await store.addNode(
        makeNode({ content: { text: "future job" }, validFrom: "2030-01-01T00:00:00.000Z" }),
      );
      const results = await store.searchNodes({ validAt: "2025-01-01T00:00:00.000Z" });
      expect(results.find((n) => n.nodeId === future.nodeId)).toBeUndefined();
    });

    // --- Search -----------------------------------------------------------

    it("searches node text by query", async () => {
      await store.addNode(makeNode({ content: { text: "TypeScript is great" } }));
      await store.addNode(makeNode({ content: { text: "Python is also fine" } }));
      const results = await store.searchNodes({ query: "TypeScript" });
      expect(results).toHaveLength(1);
      expect(results[0]?.content.text).toContain("TypeScript");
    });

    it("filters by memoryType", async () => {
      await store.addNode(makeNode({ memoryType: "Belief", content: { text: "honesty matters" } }));
      await store.addNode(makeNode({ memoryType: "Experience", content: { text: "went hiking" } }));
      const beliefs = await store.searchNodes({ memoryType: "Belief" });
      expect(beliefs).toHaveLength(1);
      expect(beliefs[0]?.memoryType).toBe("Belief");
    });

    it("filters by minConfidence", async () => {
      await store.addNode(makeNode({ confidenceWeight: 0.2, content: { text: "shaky" } }));
      await store.addNode(makeNode({ confidenceWeight: 0.9, content: { text: "solid" } }));
      const strong = await store.searchNodes({ minConfidence: 0.5 });
      expect(strong).toHaveLength(1);
      expect(strong[0]?.content.text).toBe("solid");
    });

    /**
     * Reported from outside (2026-09-14, a team importing the library): with a
     * limit and no query, a set of equal-confidence facts came back OLDEST
     * first. Every fact with decayRate 0 shares confidence, which is the common
     * case, so the tie-break decides the whole result — and "give me 10" must
     * mean the ten most recent, not the ten stalest.
     *
     * The invariant is stated as a prefix: a limited read is the start of the
     * unlimited one. That is what makes paging honest, and it is what breaks
     * when the SQL orders one way and the re-rank another.
     */
    it("a limited read is the first page of the unlimited one, newest first", async () => {
      // More than the SQLite candidate pool (200), so the pool boundary is exercised.
      for (let i = 0; i < 230; i++) {
        await store.addNode(makeNode({ content: { text: `fact ${i}` } }));
      }
      const all = await store.searchNodes({});
      const page = await store.searchNodes({ limit: 5 });
      expect(page.map((n) => n.nodeId)).toEqual(all.slice(0, 5).map((n) => n.nodeId));

      // And "first" means most recent: nothing left out was created after
      // anything returned. Timestamps are milliseconds and these inserts
      // collide, so this compares the set, not a strict sequence.
      const learned = (n: MemoryNode): string =>
        n.temporalAnchors.find((a) => a.event === "created")?.timestamp ?? n.validFrom;
      const returned = new Set(page.map((n) => n.nodeId));
      const newestExcluded = all.filter((n) => !returned.has(n.nodeId)).map(learned).sort().at(-1) ?? "";
      const oldestReturned = page.map(learned).sort()[0] ?? "";
      expect(oldestReturned >= newestExcluded).toBe(true);

      // And the whole read is in that order, which is the property the page
      // depends on — collisions in the millisecond stamp included.
      const keys = all.map((n) => `${learned(n)}|${n.nodeId}`);
      expect(keys).toEqual([...keys].sort().reverse());
    });

    /**
     * The same invariant for the keyword path. Facts phrased identically score
     * the same relevance (and, at decayRate 0, the same confidence), which is
     * exactly what repeated captures of one fact look like.
     */
    it("a limited SEARCH is the first page of the unlimited one too", async () => {
      // More than the candidate pool (200), so the pool boundary is exercised:
      // the SQL that fills it has to order the same way the re-rank does.
      for (let i = 0; i < 230; i++) {
        await store.addNode(makeNode({ content: { text: "he takes his coffee black" } }));
      }
      const all = await store.searchNodes({ query: "coffee" });
      const page = await store.searchNodes({ query: "coffee", limit: 4 });
      expect(page.map((n) => n.nodeId)).toEqual(all.slice(0, 4).map((n) => n.nodeId));
      // And asking twice gives the same answer — a total order, not the order
      // the rows happened to come back in.
      expect((await store.searchNodes({ query: "coffee", limit: 4 })).map((n) => n.nodeId)).toEqual(
        page.map((n) => n.nodeId),
      );
    });

    it("listNodes returns every node — any privacy, any retention tier, retired or not — oldest first", async () => {
      const ids: string[] = [];
      for (const privacyClassification of PRIVACY_CLASSIFICATIONS) {
        for (const retentionTier of RETENTION_TIERS) {
          const n = await store.addNode(makeNode({ privacyClassification, retentionTier, content: { text: `${privacyClassification}/${retentionTier}` } }));
          ids.push(n.nodeId);
        }
      }
      await store.updateNode(ids[0]!, { validTo: new Date().toISOString() });
      const listed = await store.listNodes();
      expect(listed.map((n) => n.nodeId).sort()).toEqual([...ids].sort());
      // Oldest learned first, id settling a shared millisecond: the reverse of compareRecency.
      const keys = listed.map((n) => `${learnedAt(n)}|${n.nodeId}`);
      expect(keys).toEqual([...keys].sort());
    });

    /**
     * Instants were compared as strings, so one moment spelled two ways
     * ("…00Z" and "…00.000Z", or an offset) landed on either side of a
     * boundary (review 2026-09-14). Every instant is stored in one canonical
     * UTC spelling, and an instant that is not one is refused.
     */
    it("stores every instant canonically, so validAt compares instants and not spellings", async () => {
      const starts = await store.addNode(makeNode({ content: { text: "starts" }, validFrom: "2026-01-01T00:00:00Z" }));
      const ends = await store.addNode(makeNode({ content: { text: "ends" }, validFrom: "2025-01-01T00:00:00Z", validTo: "2026-01-01T00:00:00Z" }));
      expect(starts.validFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(ends.validTo).toBe("2026-01-01T00:00:00.000Z");

      // Half-open [validFrom, validTo): at the shared instant, "starts" is true and "ends" is not.
      const atBoundary = await store.searchNodes({ validAt: "2026-01-01T00:00:00.000Z" });
      expect(atBoundary.map((n) => n.content.text)).toEqual(["starts"]);

      // An offset is the instant it names: 00:00 at -09:00 is 09:00 UTC.
      const offset = await store.addNode(makeNode({ content: { text: "alaska" }, validFrom: "2030-01-01T00:00:00-09:00" }));
      expect(offset.validFrom).toBe("2030-01-01T09:00:00.000Z");
      const early = await store.searchNodes({ validAt: "2030-01-01T05:00:00Z" });
      expect(early.map((n) => n.content.text)).not.toContain("alaska");

      const moved = await store.updateNode(ends.nodeId, { validTo: "2026-06-01T00:00:00+01:00" });
      expect(moved.validTo).toBe("2026-05-31T23:00:00.000Z");
    });

    it("refuses an instant it cannot place exactly", async () => {
      for (const bad of ["not a date", "2026-01-01T00:00:00", "13/01/2026"]) {
        await expect(store.addNode(makeNode({ validFrom: bad }))).rejects.toThrow(/instant/);
        await expect(store.searchNodes({ validAt: bad })).rejects.toThrow(/instant/);
      }
      const n = await store.addNode(makeNode());
      await expect(store.updateNode(n.nodeId, { validTo: "yesterday" })).rejects.toThrow(/instant/);
    });

    it("excludes Sealed nodes from search by default (governance boundary)", async () => {
      await store.addNode(
        makeNode({ privacyClassification: "Sealed", content: { text: "sealed secret" } }),
      );
      await store.addNode(
        makeNode({ privacyClassification: "Private", content: { text: "ordinary fact" } }),
      );
      const results = await store.searchNodes({});
      expect(results).toHaveLength(1);
      expect(results[0]?.content.text).toBe("ordinary fact");
    });

    it("returns Sealed nodes when explicitly requested", async () => {
      await store.addNode(
        makeNode({ privacyClassification: "Sealed", content: { text: "sealed secret" } }),
      );
      const results = await store.searchNodes({ privacyClassification: ["Sealed"] });
      expect(results).toHaveLength(1);
      expect(results[0]?.content.text).toBe("sealed secret");
    });

    it("filters by tag", async () => {
      await store.addNode(
        makeNode({ content: { text: "with Bob" }, contextualMetadata: { tags: ["people"] } }),
      );
      await store.addNode(
        makeNode({ content: { text: "a recipe" }, contextualMetadata: { tags: ["cooking"] } }),
      );
      const people = await store.searchNodes({ tags: ["people"] });
      expect(people).toHaveLength(1);
      expect(people[0]?.content.text).toBe("with Bob");
    });

    it("applies the tag filter before the limit, not after it", async () => {
      for (let i = 0; i < 12; i++) {
        await store.addNode(makeNode({ content: { text: `untagged ${i}` }, confidenceWeight: 0.95 }));
      }
      await store.addNode(
        makeNode({ content: { text: "the tagged one" }, confidenceWeight: 0.2, contextualMetadata: { tags: ["voice"] } }),
      );
      const hits = await store.searchNodes({ tags: ["voice"], limit: 5 });
      expect(hits.map((n) => n.content.text)).toEqual(["the tagged one"]);
    });

    it("treats a tags value that is not an array as untagged", async () => {
      await store.addNode(makeNode({ content: { text: "odd metadata" }, contextualMetadata: { tags: "voice" } }));
      expect(await store.searchNodes({ tags: ["voice"] })).toHaveLength(0);
    });

    it("orders query results by relevance, not static confidence", async () => {
      // A low-confidence node that is clearly about the query must outrank a
      // high-confidence node that merely mentions it in passing.
      await store.addNode(
        makeNode({
          confidenceWeight: 0.4,
          content: { text: "tokyo tokyo tokyo — travel journal about tokyo" },
        }),
      );
      await store.addNode(
        makeNode({
          confidenceWeight: 1.0,
          content: {
            text: "a long note about cooking pasta daily with olive oil garlic basil and parmesan that mentions tokyo once",
          },
        }),
      );
      const results = await store.searchNodes({ query: "tokyo" });
      expect(results[0]?.content.text).toContain("travel journal");
    });

    it("lists all embeddings for a model in one call", async () => {
      const a = await store.addNode(makeNode({ content: { text: "alpha" } }));
      const b = await store.addNode(makeNode({ content: { text: "beta" } }));
      const emb = (nodeId: string, vector: number[], model = "test-model") => ({
        nodeId,
        model,
        modelVersion: "1",
        dimensions: vector.length,
        metric: "cosine" as const,
        vector,
      });
      await store.setEmbedding(emb(a.nodeId, [1, 0]));
      await store.setEmbedding(emb(b.nodeId, [0, 1]));
      await store.setEmbedding(emb(b.nodeId, [9, 9], "other-model"));

      const all = await store.listEmbeddings("test-model");
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
      expect(all.every((e) => e.model === "test-model")).toBe(true);
    });

    it("updateNode can record a 'reinforced' anchor instead of 'modified'", async () => {
      const node = await store.addNode(makeNode({ confidenceWeight: 0.8 }));
      const updated = await store.updateNode(
        node.nodeId,
        { confidenceWeight: 0.9 },
        "reinforced",
      );
      expect(updated.temporalAnchors.at(-1)?.event).toBe("reinforced");
    });

    it("orders results by confidence descending", async () => {
      await store.addNode(makeNode({ confidenceWeight: 0.3, content: { text: "low" } }));
      await store.addNode(makeNode({ confidenceWeight: 0.8, content: { text: "high" } }));
      await store.addNode(makeNode({ confidenceWeight: 0.5, content: { text: "mid" } }));
      const results = await store.searchNodes({});
      expect(results.map((n) => n.content.text)).toEqual(["high", "mid", "low"]);
    });

    it("respects limit", async () => {
      await store.addNode(makeNode({ confidenceWeight: 0.9 }));
      await store.addNode(makeNode({ confidenceWeight: 0.8 }));
      await store.addNode(makeNode({ confidenceWeight: 0.7 }));
      const results = await store.searchNodes({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    // --- Update / delete --------------------------------------------------

    it("updates what may change and appends a 'modified' anchor", async () => {
      const node = await store.addNode(makeNode({ content: { text: "before" } }));
      const updated = await store.updateNode(node.nodeId, { contextualMetadata: { checked: true }, confidenceWeight: 0.4 });
      expect(updated.contextualMetadata).toEqual({ checked: true });
      expect(updated.confidenceWeight).toBe(0.4);
      expect(updated.temporalAnchors.at(-1)?.event).toBe("modified");
    });

    /**
     * Raw text is the source of truth. The API used to let a caller overwrite it
     * — and this suite asserted that the old words vanished (review 2026-09-14).
     * A correction is a NEW fact plus validTo on the old one.
     */
    it("refuses to change a fact's raw content", async () => {
      const node = await store.addNode(makeNode({ content: { text: "what was actually said" } }));
      await expect(
        store.updateNode(node.nodeId, { content: { text: "a tidier summary" } } as never),
      ).rejects.toThrow(/content is immutable/);
      expect((await store.getNode(node.nodeId))?.content.text).toBe("what was actually said");
      expect(await store.searchNodes({ query: "actually" })).toHaveLength(1);
    });

    it("hands back copies: changing a returned object never changes the store", async () => {
      const a = await store.addNode(makeNode({ content: { text: "kept as written" } }));
      const b = await store.addNode(makeNode());
      await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 0.5, provenance: "UserAsserted" });
      await store.setEmbedding({ nodeId: a.nodeId, model: "m", modelVersion: "1", dimensions: 2, metric: "cosine", vector: [1, 0] });

      const tamper = (n: MemoryNode | undefined) => {
        if (!n) return;
        n.content.text = "rewritten";
        n.temporalAnchors.length = 0;
        (n as { provenance: string }).provenance = "AIInferred";
        n.contextualMetadata["forged"] = true;
      };
      tamper(a);
      tamper(await store.getNode(a.nodeId));
      for (const n of await store.searchNodes({})) tamper(n);
      for (const n of await store.listNodes()) tamper(n);
      tamper(await store.updateNode(a.nodeId, { confidenceWeight: 0.9 }));
      for (const e of await store.getEdges(a.nodeId)) e.strength = 99;
      for (const v of await store.getEmbeddings(a.nodeId)) v.vector[0] = 99;
      for (const v of await store.listEmbeddings("m")) v.vector[1] = 99;

      const fresh = await store.getNode(a.nodeId);
      expect(fresh?.content.text).toBe("kept as written");
      expect(fresh?.provenance).toBe("UserInput");
      expect(fresh?.temporalAnchors.length).toBe(2); // created + the one real update
      expect(fresh?.contextualMetadata["forged"]).toBeUndefined();
      expect((await store.getEdges(a.nodeId))[0]?.strength).toBe(0.5);
      expect((await store.getEmbeddings(a.nodeId))[0]?.vector).toEqual([1, 0]);
    });

    it("throws when updating a missing node", async () => {
      await expect(store.updateNode("nope", { confidenceWeight: 0.1 })).rejects.toThrow();
    });

    it("deletes a node", async () => {
      const node = await store.addNode(makeNode());
      await store.deleteNode(node.nodeId);
      expect(await store.getNode(node.nodeId)).toBeUndefined();
    });

    // --- Edges ------------------------------------------------------------

    it("adds, retrieves, and deletes edges", async () => {
      const a = await store.addNode(makeNode({ content: { text: "cause" } }));
      const b = await store.addNode(makeNode({ content: { text: "effect" } }));
      const edge = await store.addEdge({
        sourceNodeId: a.nodeId,
        targetNodeId: b.nodeId,
        relationshipType: "Cause",
        strength: 0.9,
        provenance: "AIInferred",
      });
      expect(edge.edgeId).toBeTruthy();

      const edgesOfA = await store.getEdges(a.nodeId);
      expect(edgesOfA).toHaveLength(1);
      expect(edgesOfA[0]?.relationshipType).toBe("Cause");

      await store.deleteEdge(edge.edgeId);
      expect(await store.getEdges(a.nodeId)).toHaveLength(0);
    });

    it("removes a node's edges when the node is deleted", async () => {
      const a = await store.addNode(makeNode());
      const b = await store.addNode(makeNode());
      await store.addEdge({
        sourceNodeId: a.nodeId,
        targetNodeId: b.nodeId,
        relationshipType: "Temporal",
        strength: 1.0,
        provenance: "UserAsserted",
      });
      await store.deleteNode(a.nodeId);
      expect(await store.getEdges(b.nodeId)).toHaveLength(0);
    });

    // --- Portability: verbatim restore (round-trip import) ----------------

    it("restoreNode preserves identity, anchors, and valid-time exactly", async () => {
      const original = await store.addNode(makeNode({ content: { text: "restore me" } }));
      const retired = await store.updateNode(original.nodeId, {
        validTo: "2026-01-01T00:00:00.000Z",
      });

      const fresh = makeStore();
      await fresh.restoreNode(retired);
      const restored = await fresh.getNode(original.nodeId);
      expect(restored).toEqual(retired); // byte-for-byte: id, anchors, validTo, all of it
    });

    /**
     * restoreNode is the import path, and it used to be a back door: over an
     * existing id it replaced provenance and the anchor trail, and in SQLite it
     * delete-reinserted the row so every edge and embedding cascaded away
     * (review 2026-09-14). Re-importing a newer copy of a fact is legitimate;
     * rewriting who asserted it, what it said, or its history is not.
     */
    it("restoreNode over an existing fact updates what may change and keeps its edges and embeddings", async () => {
      const a = await store.addNode(makeNode({ content: { text: "a" } }));
      const b = await store.addNode(makeNode());
      await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 0.5, provenance: "UserAsserted" });
      await store.setEmbedding({ nodeId: a.nodeId, model: "m", modelVersion: "1", dimensions: 2, metric: "cosine", vector: [1, 0] });

      const newer = await store.updateNode(a.nodeId, { validTo: "2026-01-01T00:00:00.000Z" });
      await store.restoreNode(newer);
      expect(await store.getNode(a.nodeId)).toEqual(newer);
      expect(await store.getEdges(a.nodeId)).toHaveLength(1);
      expect(await store.getEmbeddings(a.nodeId)).toHaveLength(1);
    });

    it("restoreNode refuses to rewrite provenance, content, the key reference or the anchor trail", async () => {
      const a = await store.addNode(makeNode({ content: { text: "said once" } }));
      const later = await store.updateNode(a.nodeId, { confidenceWeight: 0.7 });
      const attempts: MemoryNode[] = [
        { ...later, provenance: "AIInferred" },
        { ...later, content: { text: "said differently" } },
        { ...later, encryptionKeyRef: "another-key" },
        { ...later, temporalAnchors: [] },
        { ...later, temporalAnchors: later.temporalAnchors.slice(1) },
        { ...later, temporalAnchors: [{ ...later.temporalAnchors[0]!, timestamp: "1999-01-01T00:00:00.000Z" }, ...later.temporalAnchors.slice(1)] },
      ];
      for (const attempt of attempts) {
        await expect(store.restoreNode(attempt)).rejects.toThrow(/immutable|history/);
      }
      expect(await store.getNode(a.nodeId)).toEqual(later);
    });

    it("restoreNode refuses a fact with no creation anchor", async () => {
      const a = await store.addNode(makeNode());
      const fresh = makeStore();
      await expect(fresh.restoreNode({ ...a, nodeId: "no-anchor-node", temporalAnchors: [] })).rejects.toThrow(/created/);
      (fresh as { close?: () => void }).close?.();
    });

    it("a restoreEdge that fails leaves the edge it would have replaced", async () => {
      const a = await store.addNode(makeNode());
      const b = await store.addNode(makeNode());
      const edge = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 0.5, provenance: "UserAsserted" });
      // Pointing the same edge at a fact that does not exist must fail as a
      // whole — SQLite used to delete the original first, then fail the insert.
      await expect(store.restoreEdge({ ...edge, targetNodeId: "no-such-node" })).rejects.toThrow();
      expect(await store.getEdges(a.nodeId)).toEqual([edge]);
    });

    it("restoreEdge preserves the edge verbatim", async () => {
      const a = await store.addNode(makeNode());
      const b = await store.addNode(makeNode());
      const edge = await store.addEdge({
        sourceNodeId: a.nodeId,
        targetNodeId: b.nodeId,
        relationshipType: "Reinforcement",
        strength: 0.7,
        provenance: "AIInferred",
      });

      const fresh = makeStore();
      await fresh.restoreNode(a);
      await fresh.restoreNode(b);
      await fresh.restoreEdge(edge);
      const edges = await fresh.getEdges(a.nodeId);
      expect(edges).toEqual([edge]);
    });

    // --- Embeddings (model-tagged cache) ----------------------------------

    it("stores and retrieves a model-tagged embedding", async () => {
      const node = await store.addNode(makeNode());
      const emb = await store.setEmbedding({
        nodeId: node.nodeId,
        model: "voyage-3-large",
        modelVersion: "1",
        dimensions: 3,
        metric: "cosine",
        vector: [0.1, 0.2, 0.3],
      });
      expect(emb.createdAt).toBeTruthy();

      const all = await store.getEmbeddings(node.nodeId);
      expect(all).toHaveLength(1);
      expect(all[0]?.model).toBe("voyage-3-large");
      expect(all[0]?.vector).toEqual([0.1, 0.2, 0.3]);
    });

    it("replaces the vector when re-embedding with the same model", async () => {
      const node = await store.addNode(makeNode());
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m1",
        modelVersion: "1",
        dimensions: 2,
        metric: "cosine",
        vector: [1, 1],
      });
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m1",
        modelVersion: "2",
        dimensions: 2,
        metric: "cosine",
        vector: [2, 2],
      });
      const all = await store.getEmbeddings(node.nodeId);
      expect(all).toHaveLength(1);
      expect(all[0]?.vector).toEqual([2, 2]);
      expect(all[0]?.modelVersion).toBe("2");
    });

    it("keeps embeddings from different models side by side", async () => {
      const node = await store.addNode(makeNode());
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m1",
        modelVersion: "1",
        dimensions: 2,
        metric: "cosine",
        vector: [1, 1],
      });
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m2",
        modelVersion: "1",
        dimensions: 2,
        metric: "dot",
        vector: [9, 9],
      });
      const all = await store.getEmbeddings(node.nodeId);
      expect(all).toHaveLength(2);
      expect(new Set(all.map((e) => e.model))).toEqual(new Set(["m1", "m2"]));
    });

    it("deletes one model's embedding or all of them", async () => {
      const node = await store.addNode(makeNode());
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m1",
        modelVersion: "1",
        dimensions: 1,
        metric: "cosine",
        vector: [1],
      });
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m2",
        modelVersion: "1",
        dimensions: 1,
        metric: "cosine",
        vector: [2],
      });

      await store.deleteEmbeddings(node.nodeId, "m1");
      expect(await store.getEmbeddings(node.nodeId)).toHaveLength(1);

      await store.deleteEmbeddings(node.nodeId);
      expect(await store.getEmbeddings(node.nodeId)).toHaveLength(0);
    });

    it("drops a node's embeddings when the node is deleted", async () => {
      const node = await store.addNode(makeNode());
      await store.setEmbedding({
        nodeId: node.nodeId,
        model: "m1",
        modelVersion: "1",
        dimensions: 1,
        metric: "cosine",
        vector: [1],
      });
      await store.deleteNode(node.nodeId);
      expect(await store.getEmbeddings(node.nodeId)).toHaveLength(0);
    });
  });
}
