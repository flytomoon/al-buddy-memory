import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { learnedAt } from "./decay.js";
import { isHistoryCapable, mutableState } from "./history.js";
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

    describe("transaction time", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      const historyStore = () => {
        if (!isHistoryCapable(store)) throw new Error("shipped store must implement HistoryCapable");
        return store;
      };

      it("reconstructs corrected beliefs and combines transaction time with valid time", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode({ validFrom: "2026-01-01T00:00:00.000Z" }));
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        await store.updateNode(fact.nodeId, { validFrom: "2026-03-01T00:00:00.000Z" });
        vi.setSystemTime("2026-04-01T00:00:00.000Z");
        await store.updateNode(fact.nodeId, { validTo: "2026-05-01T00:00:00.000Z" });

        const [t1, t2, t3] = await Promise.all(["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"].map((at) => historyStore().getNodeAsOf(fact.nodeId, at)));
        // Fully recorded history: every read is vouched for.
        expect([t1?.exact, t2?.exact, t3?.exact]).toEqual([true, true, true]);
        const [atT1, atT2, atT3] = [t1?.node, t2?.node, t3?.node];
        expect(atT1?.validFrom).toBe("2026-01-01T00:00:00.000Z");
        expect(atT2?.validFrom).toBe("2026-03-01T00:00:00.000Z");
        expect(atT2?.validTo).toBeNull();
        expect(atT3?.validTo).toBe("2026-05-01T00:00:00.000Z");
        const feb = "2026-02-15T00:00:00.000Z";
        expect(atT1!.validFrom <= feb && (atT1!.validTo === null || atT1!.validTo > feb)).toBe(true);
        expect(atT2!.validFrom <= feb && (atT2!.validTo === null || atT2!.validTo > feb)).toBe(false);
        // The same question in one call: believed at T1 / T2, true in mid-February.
        expect((await historyStore().snapshotAsOf("2026-01-01T00:00:00.000Z", { validAt: feb })).nodes.map((n) => n.nodeId)).toEqual([fact.nodeId]);
        expect((await historyStore().snapshotAsOf("2026-02-01T00:00:00.000Z", { validAt: feb })).nodes).toEqual([]);
      });

      it("omits a fact before it was learned", async () => {
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode());
        expect(await historyStore().getNodeAsOf(fact.nodeId, "2026-01-01T00:00:00Z")).toBeUndefined();
        expect((await historyStore().snapshotAsOf("2026-01-01T00:00:00Z")).nodes).toEqual([]);
      });

      it("records one full-image version for every update including an empty patch", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode());
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        const updated = await store.updateNode(fact.nodeId, { confidenceWeight: 0.7 });
        vi.setSystemTime("2026-03-01T00:00:00.000Z");
        const reinforced = await store.updateNode(fact.nodeId, {}, "reinforced");
        const versions = await historyStore().history(fact.nodeId);
        expect(versions).toHaveLength(2);
        expect(versions[0]).toMatchObject({ recordedAt: updated.temporalAnchors[1]!.timestamp, event: "modified", before: mutableState(fact), after: mutableState(updated) });
        expect(versions[1]).toMatchObject({ recordedAt: reinforced.temporalAnchors[2]!.timestamp, event: "reinforced", before: mutableState(updated), after: mutableState(reinforced) });
        expect(versions[0]!.after).toEqual(versions[1]!.before);
      });

      it("erasure removes versions and wins over every past as-of read", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode());
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        await store.updateNode(fact.nodeId, { confidenceWeight: 0.5 });
        await store.deleteNode(fact.nodeId);
        expect(await historyStore().history(fact.nodeId)).toEqual([]);
        expect(await historyStore().getNodeAsOf(fact.nodeId, "2026-01-15T00:00:00Z")).toBeUndefined();
        expect((await historyStore().snapshotAsOf("2026-01-15T00:00:00Z")).nodes).toEqual([]);
        await store.restoreNode(fact);
        expect(await historyStore().history(fact.nodeId)).toEqual([]);
        await store.deleteNode(fact.nodeId);
      });

      it("orders two updates in one millisecond and applies both inclusively", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode());
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        await store.updateNode(fact.nodeId, { confidenceWeight: 0.8 });
        await store.updateNode(fact.nodeId, { confidenceWeight: 0.6 });
        const versions = await historyStore().history(fact.nodeId);
        expect(versions.map((version) => version.after.confidenceWeight)).toEqual([0.8, 0.6]);
        expect((await historyStore().getNodeAsOf(fact.nodeId, "2026-02-01T00:00:00.000Z"))?.node.confidenceWeight).toBe(0.6);
      });

      it("records changed restores once and ignores identical restores", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const fact = await store.addNode(makeNode());
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        await store.restoreNode({ ...fact, confidenceWeight: 0.4 });
        await store.restoreNode({ ...fact, confidenceWeight: 0.4 });
        expect(await historyStore().history(fact.nodeId)).toMatchObject([{ event: "restored", before: { confidenceWeight: 1 }, after: { confidenceWeight: 0.4 } }]);
      });

      it("marks legacy missing versions inexact but fully recorded history exact", async () => {
        const legacy = { ...(await store.addNode(makeNode())), nodeId: globalThis.crypto.randomUUID() };
        await store.restoreNode({ ...legacy, temporalAnchors: [
          { timestamp: "2026-01-01T00:00:00.000Z", event: "created" },
          { timestamp: "2026-03-01T00:00:00.000Z", event: "modified" },
        ], validFrom: "2026-01-01T00:00:00.000Z" });
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const exact = await store.addNode(makeNode());
        vi.setSystemTime("2026-03-01T00:00:00.000Z");
        await store.updateNode(exact.nodeId, { confidenceWeight: 0.5 });
        const snap = await historyStore().snapshotAsOf("2026-02-01T00:00:00Z");
        expect(snap.inexact).toContain(legacy.nodeId);
        expect(snap.inexact).not.toContain(exact.nodeId);
      });

      it("omits edges that had not been created yet", async () => {
        vi.setSystemTime("2026-01-01T00:00:00.000Z");
        const a = await store.addNode(makeNode());
        const b = await store.addNode(makeNode());
        vi.setSystemTime("2026-02-01T00:00:00.000Z");
        await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
        expect((await historyStore().snapshotAsOf("2026-01-01T00:00:00.000Z")).edges).toEqual([]);
        expect((await historyStore().snapshotAsOf("2026-02-01T00:00:00.000Z")).edges).toHaveLength(1);
      });

      it("restores versions idempotently and refuses a conflicting id", async () => {
        const fact = await store.addNode(makeNode());
        const state = mutableState(fact);
        // A `restored` version carries no anchor, so it only has to fall between the
        // fact being learned and now; the learning instant itself is both.
        const recordedAt = learnedAt(fact);
        const version = { versionId: "00000000-0000-4000-8000-000000000099", nodeId: fact.nodeId, recordedAt, event: "restored" as const, before: state, after: { ...state, confidenceWeight: 0.5 } };
        await historyStore().restoreVersion(version);
        await historyStore().restoreVersion(version);
        expect(await historyStore().history(fact.nodeId)).toHaveLength(1);
        await expect(historyStore().restoreVersion({ ...version, after: { ...state, confidenceWeight: 0.4 } })).rejects.toThrow(/different/);
        await expect(historyStore().restoreVersion({ ...version, versionId: "00000000-0000-4000-8000-000000000098", nodeId: "missing-node" })).rejects.toThrow(/does not exist/);
      });
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
      // 2026-02-30 used to be accepted and silently became 2 March (Fable re-review).
      for (const bad of ["not a date", "2026-01-01T00:00:00", "13/01/2026", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z"]) {
        await expect(store.addNode(makeNode({ validFrom: bad }))).rejects.toThrow(/instant/);
        await expect(store.searchNodes({ validAt: bad })).rejects.toThrow(/instant/);
      }
      const n = await store.addNode(makeNode());
      await expect(store.updateNode(n.nodeId, { validTo: "yesterday" })).rejects.toThrow(/instant/);
      // RFC 3339 allows lowercase separators; a date alone is midnight UTC.
      expect((await store.addNode(makeNode({ validFrom: "2026-01-01t12:00:00z" }))).validFrom).toBe("2026-01-01T12:00:00.000Z");
      expect((await store.addNode(makeNode({ validFrom: "2024-02-29" }))).validFrom).toBe("2024-02-29T00:00:00.000Z");
    });

    /**
     * The 0.3.5 changelog claimed the prefix property unconditionally; it held
     * only when nothing decays. SQLite filled its candidate pool by STORED
     * confidence and ranked by EFFECTIVE, so a fresh 0.9 fact lost to a pool of
     * 200 stale 1.0 facts that had decayed to 0.5 (review 2026-09-14).
     */
    it("a limited read is still the first page when facts have decayed, with or without a query", async () => {
      const old = "2020-01-01T00:00:00.000Z";
      for (let i = 0; i < 250; i++) {
        await store.restoreNode({
          ...makeNode({ content: { text: `coffee note ${i}` }, confidenceWeight: 1, decayRate: 1 }),
          nodeId: globalThis.crypto.randomUUID(),
          temporalAnchors: [{ timestamp: old, event: "created" }],
          validFrom: old,
          validTo: null,
        });
      }
      const fresh = await store.addNode(makeNode({ content: { text: "coffee note fresh" }, confidenceWeight: 0.9, decayRate: 0 }));

      for (const query of [undefined, "coffee"]) {
        const all = await store.searchNodes(query === undefined ? {} : { query });
        expect(all[0]?.nodeId).toBe(fresh.nodeId);
        const page = await store.searchNodes(query === undefined ? { limit: 5 } : { query, limit: 5 });
        expect(page.map((n) => n.nodeId)).toEqual(all.slice(0, 5).map((n) => n.nodeId));
      }
    });

    /**
     * The widening must stay exact when it is narrowed for speed (Fable
     * re-review, 2026-09-15): a fact left out of the pool that TIES the page's
     * lowest effective confidence, but is newer, belongs on the page. A strict
     * "stored > floor" widening would miss it; so would none at all.
     */
    it("a left-out fact that ties the page on confidence but is newer still makes the page", async () => {
      const old = "2020-01-01T00:00:00.000Z";
      for (let i = 0; i < 200; i++) {
        await store.restoreNode({
          ...makeNode({ content: { text: `coffee stale ${i}` }, confidenceWeight: 1, decayRate: 1 }), // decays to exactly the 0.5 floor
          nodeId: globalThis.crypto.randomUUID(),
          temporalAnchors: [{ timestamp: old, event: "created" }],
          validFrom: old,
          validTo: null,
        });
      }
      const tie = await store.addNode(makeNode({ content: { text: "coffee fresh tie" }, confidenceWeight: 0.5, decayRate: 0 }));
      for (const query of [undefined, "coffee"]) {
        const page = await store.searchNodes(query === undefined ? { limit: 1 } : { query, limit: 1 });
        const all = await store.searchNodes(query === undefined ? {} : { query });
        expect(page.map((n) => n.nodeId)).toEqual(all.slice(0, 1).map((n) => n.nodeId));
        if (query === undefined) expect(page[0]?.nodeId).toBe(tie.nodeId);
      }
    });

    /**
     * The paging rule has three moving parts (the pool, the decay-aware widening
     * and the skip when nothing can win), so it is held to the property itself
     * on random stores built to tie: few confidence values, few creation
     * instants, a third of facts decaying, two texts. Seeded, so a failure
     * reproduces.
     */
    it("on random stores full of ties, every limited read is a prefix of the unlimited one", async () => {
      let seed = 20260915;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const instants = ["2020-01-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", new Date().toISOString()];
      // Shaped to stress the pool's edge: most facts are stored at 1 and decayed
      // (they fill the pool), a minority are fresh at 0.5 (tying the decayed ones)
      // or 0.9 (beating them) and sort AFTER them in SQL — exactly the rows a
      // wrong widening would leave out.
      for (let i = 0; i < 300; i++) {
        const stale = rnd() < 0.75;
        const at = stale ? pick(instants.slice(0, 2)) : pick(instants.slice(1));
        await store.restoreNode({
          ...makeNode({
            content: { text: pick(["coffee black", "coffee with milk and sugar"]) },
            confidenceWeight: stale ? 1 : pick([0.5, 0.5, 0.9]),
            decayRate: stale ? 1 : pick([0, 0, 0.001]),
          }),
          nodeId: globalThis.crypto.randomUUID(),
          temporalAnchors: [{ timestamp: at, event: "created" }],
          validFrom: at,
          validTo: null,
        });
      }
      for (const query of [undefined, "coffee", "milk"]) {
        const all = (await store.searchNodes(query === undefined ? {} : { query })).map((n) => n.nodeId);
        for (const limit of [1, 2, 7, 10, 15, 20]) {
          const page = (await store.searchNodes(query === undefined ? { limit } : { query, limit })).map((n) => n.nodeId);
          expect(page, `query=${query} limit=${limit}`).toEqual(all.slice(0, limit));
        }
      }
    });

    /**
     * Confidence is a weight in [0,1] and decay a rate ≥ 0. Nothing checked it,
     * and the exact-paging proof rests on effective ≤ stored — false for a
     * negative confidence, which Fable used to break a page (final review).
     */
    it("refuses a confidence outside [0,1] or a negative or non-finite decay rate, on every write path", async () => {
      for (const bad of [{ confidenceWeight: -1 }, { confidenceWeight: 1.5 }, { confidenceWeight: Number.NaN }, { decayRate: -0.1 }, { decayRate: Number.POSITIVE_INFINITY }]) {
        await expect(store.addNode(makeNode(bad))).rejects.toThrow(/confidenceWeight|decayRate/);
      }
      const n = await store.addNode(makeNode());
      await expect(store.updateNode(n.nodeId, { confidenceWeight: 2 })).rejects.toThrow(/confidenceWeight/);
      await expect(store.restoreNode({ ...n, decayRate: -1 })).rejects.toThrow(/decayRate/);
      expect((await store.getNode(n.nodeId))?.confidenceWeight).toBe(1);
    });

    /**
     * The same rule for the words. A store that accepted `privacyClassification:
     * "sensitive"` wrote a fact governance reads by string equality — so a fact
     * the person meant to hide was visible to a stranger — and its own export
     * then failed the published schema. TypeScript callers cannot write these;
     * JavaScript callers, imports and other-language ports can, so the store
     * refuses them at runtime (Astra R8 + Fable, 2026-09-18).
     */
    it("refuses a word outside the published vocabulary, on every write path", async () => {
      const bad: Partial<NewMemoryNode>[] = [
        { provenance: "Hacker" as never },
        { memoryType: "Whatever" as never },
        { privacyClassification: "sensitive" as never },
        { retentionTier: "Forever" as never },
      ];
      for (const b of bad) {
        await expect(store.addNode(makeNode(b))).rejects.toThrow(/provenance|memoryType|privacyClassification|retentionTier/);
      }
      const n = await store.addNode(makeNode());
      await expect(store.updateNode(n.nodeId, { privacyClassification: "sensitive" as never })).rejects.toThrow(/privacyClassification/);
      await expect(store.updateNode(n.nodeId, { retentionTier: "Forever" as never })).rejects.toThrow(/retentionTier/);
      await expect(store.updateNode(n.nodeId, { memoryType: "Whatever" as never })).rejects.toThrow(/memoryType/);
      await expect(store.restoreNode({ ...n, provenance: "Hacker" as never })).rejects.toThrow(/provenance/);
      await expect(
        store.restoreNode({ ...n, temporalAnchors: [...n.temporalAnchors, { timestamp: n.validFrom, event: "invented" as never }] }),
      ).rejects.toThrow(/event/);
      await expect(store.updateNode(n.nodeId, {}, "invented" as never)).rejects.toThrow(/event/);
      expect((await store.getNode(n.nodeId))?.privacyClassification).toBe("Private");
      expect((await store.getNode(n.nodeId))?.provenance).toBe("UserInput");
    });

    it("refuses an edge outside the published vocabulary, or a strength outside [0,1]", async () => {
      const a = await store.addNode(makeNode());
      const b = await store.addNode(makeNode());
      const edge = { sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Reinforcement" as const, strength: 0.5, provenance: "UserAsserted" as const };
      await expect(store.addEdge({ ...edge, relationshipType: "Friend" as never })).rejects.toThrow(/relationshipType/);
      await expect(store.addEdge({ ...edge, provenance: "Nobody" as never })).rejects.toThrow(/provenance/);
      await expect(store.addEdge({ ...edge, strength: 7 })).rejects.toThrow(/strength/);
      await expect(store.addEdge({ ...edge, strength: Number.NaN })).rejects.toThrow(/strength/);
      expect(await store.getEdges(a.nodeId)).toEqual([]);
      const saved = await store.addEdge(edge);
      await expect(store.restoreEdge({ ...saved, edgeId: "other", strength: 9 })).rejects.toThrow(/strength/);
    });

    /**
     * `{validTo: undefined}` is a JavaScript caller's omitted key, not an
     * instruction to erase the field. It left `validTo: undefined` in memory —
     * the fact vanished from every validAt read and the export failed the
     * schema — while SQLite wrote null: two stores, two answers (Fable,
     * 2026-09-18).
     */
    it("treats an undefined patch value as an absent key, not as an erasure", async () => {
      const n = await store.addNode(makeNode({ validFrom: "2026-01-01T00:00:00Z", validTo: "2026-02-01T00:00:00Z" }));
      const patched = await store.updateNode(n.nodeId, { validTo: undefined, confidenceWeight: 0.5 });
      expect(patched.validTo).toBe("2026-02-01T00:00:00.000Z");
      expect(patched.confidenceWeight).toBe(0.5);
      const fresh = await store.getNode(n.nodeId);
      expect(fresh?.validTo).toBe("2026-02-01T00:00:00.000Z");
      expect(await store.searchNodes({ validAt: "2026-01-15T00:00:00Z" })).toHaveLength(1);
      const open = await store.addNode(makeNode({ validFrom: "2026-01-01T00:00:00Z" }));
      expect((await store.updateNode(open.nodeId, { validFrom: undefined })).validTo).toBeNull();
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

    // --- Paging (review 2026-09-22) ---------------------------------------

    /**
     * `after` continues the list it came from. The SQLite store used to filter
     * `created_at >` the cursor while returning newest first, so page 2 was the
     * facts NEWER than the cursor — page 1 again — and nothing past it was ever
     * reached.
     */
    describe("paging with after", () => {
      beforeEach(() => vi.useFakeTimers());
      afterEach(() => vi.useRealTimers());

      const seed = async (n: number, text = (i: number) => `fact ${i}`) => {
        for (let i = 0; i < n; i++) {
          vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
          await store.addNode(makeNode({ content: { text: text(i) } }));
        }
      };

      it("page 2 is the next page of the same list, without a query", async () => {
        await seed(7);
        const all = (await store.searchNodes({})).map((n) => n.nodeId);
        const pages: string[] = [];
        let after: string | undefined;
        for (;;) {
          const page = (await store.searchNodes(after === undefined ? { limit: 3 } : { limit: 3, after })).map((n) => n.nodeId);
          if (page.length === 0) break;
          pages.push(...page);
          after = page[page.length - 1];
        }
        expect(pages).toEqual(all);
      });

      it("page 2 is the next page of the same list, with a query", async () => {
        await seed(7, (i) => `coffee note ${i}`);
        const all = (await store.searchNodes({ query: "coffee" })).map((n) => n.nodeId);
        const page1 = (await store.searchNodes({ query: "coffee", limit: 3 })).map((n) => n.nodeId);
        const page2 = (await store.searchNodes({ query: "coffee", limit: 3, after: page1[2]! })).map((n) => n.nodeId);
        expect([...page1, ...page2]).toEqual(all.slice(0, 6));
      });

      it("a cursor that is not in the list has nothing after it", async () => {
        await seed(3);
        expect(await store.searchNodes({ after: "00000000-0000-4000-8000-00000000dead" })).toEqual([]);
        expect(await store.searchNodes({ after: "00000000-0000-4000-8000-00000000dead", limit: 2 })).toEqual([]);
      });
    });

    it("limit means the same on every store: negative is none, non-finite is no limit, fractions round down", async () => {
      for (let i = 0; i < 3; i++) await store.addNode(makeNode({ content: { text: `fact ${i}` } }));
      expect(await store.searchNodes({ limit: -1 })).toHaveLength(0);
      expect(await store.searchNodes({ limit: 0 })).toHaveLength(0);
      expect(await store.searchNodes({ limit: Number.NaN })).toHaveLength(3);
      expect(await store.searchNodes({ limit: Number.POSITIVE_INFINITY })).toHaveLength(3);
      expect(await store.searchNodes({ limit: 2.7 })).toHaveLength(2);
    });

    // --- A clock that steps back (review 2026-09-22) ---------------------

    /**
     * An NTP correction or a resumed VM can move the clock backwards between
     * two changes to one fact. The store used to stamp the change with the
     * clock as it was, so the fact's own version was dated before it was
     * learned and its own export could not be imported back.
     */
    it("a change is never stamped before the fact's last recorded moment", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-09-22T10:00:05.000Z"));
        const fact = await store.addNode(makeNode());
        vi.setSystemTime(new Date("2026-09-22T10:00:01.000Z"));
        const once = await store.updateNode(fact.nodeId, { confidenceWeight: 0.5 });
        const twice = await store.updateNode(fact.nodeId, { confidenceWeight: 0.4 });
        const stamps = twice.temporalAnchors.map((a) => Date.parse(a.timestamp));
        for (let i = 1; i < stamps.length; i++) expect(stamps[i]!).toBeGreaterThanOrEqual(stamps[i - 1]!);
        // Held at the fact's last moment while the clock is behind; not pushed past it.
        expect(once.temporalAnchors.at(-1)!.timestamp).toBe("2026-09-22T10:00:05.000Z");
        if (isHistoryCapable(store)) {
          const recorded = (await store.history(fact.nodeId)).map((v) => v.recordedAt);
          expect(recorded).toEqual(twice.temporalAnchors.slice(1).map((a) => a.timestamp));
        }
      } finally {
        vi.useRealTimers();
      }
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

    /**
     * There is no updateEdge: a link, once written, says what it says. restoreEdge
     * over an existing id used to replace it — so a caller refused an erasure
     * could rewrite the link instead (Astra re-review, 2026-09-15).
     */
    it("restoreEdge re-imports an identical link and refuses to rewrite one", async () => {
      const a = await store.addNode(makeNode());
      const b = await store.addNode(makeNode());
      const c = await store.addNode(makeNode());
      const edge = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 0.5, provenance: "UserAsserted" });
      await store.restoreEdge(edge); // idempotent import
      await expect(store.restoreEdge({ ...edge, targetNodeId: c.nodeId })).rejects.toThrow(/immutable/);
      await expect(store.restoreEdge({ ...edge, relationshipType: "Contradiction" })).rejects.toThrow(/immutable/);
      expect(await store.getEdges(a.nodeId)).toEqual([edge]);
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
