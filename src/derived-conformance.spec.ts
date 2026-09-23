/**
 * What happens to a conclusion when the fact it was drawn from goes — the two
 * paths, as every MemoryStore must implement them (our 2026-09-22 review of the
 * erase path):
 *
 *   - STOPPED BEING TRUE (validTo set): every live conclusion resting on it is
 *     retracted — validTo set, text and history kept, a `retraction` naming the
 *     source — so as-of reads still show what was believed and when it stopped.
 *   - MUST NOT EXIST (deleteNode): the fact is erased with everything built from
 *     it, transitively, histories included, in one transaction.
 *
 * Exported and run by each store's own test file, like the main conformance suite.
 */
import { describe, expect, it } from "vitest";

import { makeNode } from "./memory-store-conformance.spec.js";
import { isHistoryCapable } from "./history.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "./types/memory.js";

/** A conclusion the nightly pass would write: AIInferred, citing its sources. */
export function makeDerived(sources: readonly string[], overrides: Partial<NewMemoryNode> = {}): NewMemoryNode {
  return makeNode({
    provenance: "AIInferred",
    content: { text: `derived from ${sources.join(", ")}` },
    contextualMetadata: { derivedFrom: [...sources], consolidatedAt: "2026-09-22T00:00:00.000Z", consolidatedBy: "test-model", tags: ["derived"] },
    ...overrides,
  });
}

async function all(store: MemoryStore): Promise<MemoryNode[]> {
  return store.listNodes();
}

export function runDerivedConformance(label: string, makeStore: () => MemoryStore): void {
  describe(`${label} — what a conclusion does when its source goes`, () => {
    it("erasing a fact erases every conclusion drawn from it, transitively, and nothing else", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode({ content: { text: "Lives in Tokyo" } }));
      const other = await store.addNode(makeNode({ content: { text: "Likes tea" } }));
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      const d2 = await store.addNode(makeDerived([d1.nodeId])); // a conclusion from a conclusion
      const mixed = await store.addNode(makeDerived([source.nodeId, other.nodeId])); // also rests on a survivor
      const unrelated = await store.addNode(makeDerived([other.nodeId]));
      await store.addEdge({ sourceNodeId: d1.nodeId, targetNodeId: source.nodeId, relationshipType: "Reinforcement", strength: 0.7, provenance: "AIInferred" });

      await store.deleteNode(source.nodeId);

      const left = (await all(store)).map((n) => n.nodeId).sort();
      expect(left).toEqual([other.nodeId, unrelated.nodeId].sort());
      for (const gone of [source, d1, d2, mixed]) expect(await store.getNode(gone.nodeId)).toBeUndefined();
      expect(await store.getEdges(d1.nodeId)).toEqual([]);
    });

    it("erasing a conclusion erases what was drawn from it, and leaves its sources", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      const d2 = await store.addNode(makeDerived([d1.nodeId]));
      await store.deleteNode(d1.nodeId);
      expect(await store.getNode(source.nodeId)).toBeDefined();
      expect(await store.getNode(d2.nodeId)).toBeUndefined();
    });

    it("an erased conclusion takes its history with it", async () => {
      const store = makeStore();
      if (!isHistoryCapable(store)) return;
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      await store.updateNode(d1.nodeId, { confidenceWeight: 0.5 });
      expect(await store.history(d1.nodeId)).toHaveLength(1);
      await store.deleteNode(source.nodeId);
      expect(await store.history(d1.nodeId)).toEqual([]);
    });

    it("a source that stops being true retracts its live conclusions — kept, marked, never erased", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode({ content: { text: "Lives in Tokyo" } }));
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      const d2 = await store.addNode(makeDerived([d1.nodeId]));
      const until = "2026-09-20T00:00:00.000Z";

      await store.updateNode(source.nodeId, { validTo: until });

      for (const d of [d1, d2]) {
        const after = (await store.getNode(d.nodeId))!;
        expect(after.content.text).toBe(d.content.text);
        expect(after.validTo).toBe(until);
        expect(after.contextualMetadata["retraction"]).toMatchObject({ by: "invalidation" });
        expect(String((after.contextualMetadata["retraction"] as { reason: string }).reason)).toContain(d === d1 ? source.nodeId : d1.nodeId);
      }
    });

    it("the retraction is history: an as-of read before it shows what was believed", async () => {
      const store = makeStore();
      if (!isHistoryCapable(store)) return;
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      await store.updateNode(source.nodeId, { validTo: "2026-09-20T00:00:00.000Z" });
      const versions = await store.history(d1.nodeId);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.before.validTo).toBeNull();
      expect(versions[0]!.after.validTo).toBe("2026-09-20T00:00:00.000Z");
    });

    it("a conclusion already retracted is left as it was — no second retraction, no new version", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId], { validTo: "2026-09-01T00:00:00.000Z" }));
      await store.updateNode(source.nodeId, { validTo: "2026-09-20T00:00:00.000Z" });
      const after = (await store.getNode(d1.nodeId))!;
      expect(after.validTo).toBe("2026-09-01T00:00:00.000Z");
      expect(after.contextualMetadata["retraction"]).toBeUndefined();
      if (isHistoryCapable(store)) expect(await store.history(d1.nodeId)).toEqual([]);
    });

    it("bringing the source back does not quietly bring its conclusions back", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      await store.updateNode(source.nodeId, { validTo: "2026-09-20T00:00:00.000Z" });
      await store.updateNode(source.nodeId, { validTo: null });
      expect((await store.getNode(d1.nodeId))!.validTo).toBe("2026-09-20T00:00:00.000Z");
    });

    it("an import is restored as written: restoreNode never cascades", async () => {
      const store = makeStore();
      const source = await store.addNode(makeNode());
      const d1 = await store.addNode(makeDerived([source.nodeId]));
      const s = (await store.getNode(source.nodeId))!;
      await store.restoreNode({ ...s, validTo: "2026-09-20T00:00:00.000Z", temporalAnchors: [...s.temporalAnchors, { timestamp: new Date().toISOString(), event: "modified" }] });
      expect((await store.getNode(d1.nodeId))!.validTo).toBeNull();
    });
  });
}
