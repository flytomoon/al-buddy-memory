/**
 * The two paths a source can take, on a governed handle (our 2026-09-22 review
 * of the erase path): erasure takes everything built from the fact and is
 * judged as ONE decision; invalidation retracts what was concluded from it and
 * keeps it.
 */
import { describe, expect, it } from "vitest";

import { makeDerived } from "../derived-conformance.spec.js";
import { InMemoryStore } from "../in-memory-store.js";
import { governanceTools } from "../mcp/governance-server.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryStore } from "../types/memory.js";
import { MemoryAudit } from "./audit.js";
import { DELETION_REQUEST, govern, isRecentlyDeletedCapable, type RecentlyDeletedCapable } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";
import { memoryLock, personalDefaults } from "./samples.js";

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const };
const fact = (text: string) => ({ ...base, provenance: "UserInput" as const, content: { text } });
const T0 = Date.parse("2026-09-01T12:00:00.000Z");

const stores: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

function setup(make: () => MemoryStore, opts: { policies?: GovernancePolicy[]; bin?: boolean } = {}) {
  const inner = make();
  const audit = new MemoryAudit();
  const store = govern(inner, {
    policies: [personalDefaults({ owner: "o" }), ...(opts.policies ?? [])],
    context: () => ({ actor: "o", now: new Date(T0) }),
    audit,
    ...(opts.bin ? { recentlyDeleted: { days: 14 } } : {}),
  });
  return { inner, audit, store };
}

/** A source with a conclusion and a conclusion drawn from that, written straight to the inner store. */
async function chain(inner: MemoryStore) {
  const source = await inner.addNode(fact("the gate code is 4411"));
  const d1 = await inner.addNode(makeDerived([source.nodeId]));
  const d2 = await inner.addNode(makeDerived([d1.nodeId]));
  return { source, d1, d2 };
}

describe.each(stores)("erasure reaches what was derived from it (%s)", (_label, make) => {
  it("erases the fact and every conclusion built on it, as one audited decision", async () => {
    const { inner, audit, store } = setup(make);
    const { source, d1, d2 } = await chain(inner);
    await store.deleteNode(source.nodeId);
    for (const id of [source.nodeId, d1.nodeId, d2.nodeId]) expect(await inner.getNode(id)).toBeUndefined();
    const erased = audit.events.filter((e) => e.purpose === "erase" && e.outcome === "allowed");
    expect(erased).toHaveLength(1);
    expect(erased[0]!.nodeIds.sort()).toEqual([source.nodeId, d1.nodeId, d2.nodeId].sort());
  });

  it("the lock refuses the whole erase before anything changes", async () => {
    const { inner, store } = setup(make, { policies: [memoryLock()] });
    const { source, d1, d2 } = await chain(inner);
    await expect(store.deleteNode(source.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    for (const id of [source.nodeId, d1.nodeId, d2.nodeId]) expect(await inner.getNode(id)).toBeDefined();
  });

  it("a policy that may not erase one conclusion refuses the whole erase, and says which", async () => {
    const guardD2: GovernancePolicy = {
      name: "keep-d2",
      beforeErase(subject) {
        if (subject.node && subject.node.contextualMetadata["keep"] === true) throw new PolicyDenied("keep-d2", "this one is kept");
        return undefined;
      },
    };
    const { inner, store } = setup(make, { policies: [guardD2] });
    const source = await inner.addNode(fact("s"));
    const d1 = await inner.addNode(makeDerived([source.nodeId], { contextualMetadata: { derivedFrom: [source.nodeId], consolidatedAt: "2026-09-22T00:00:00.000Z", keep: true } }));
    const err = await store.deleteNode(source.nodeId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDenied);
    expect(String((err as Error).message)).toContain(d1.nodeId);
    expect(await inner.getNode(source.nodeId)).toBeDefined();
    expect(await inner.getNode(d1.nodeId)).toBeDefined();
  });
});

describe.each(stores)("Recently deleted holds a fact and its conclusions together (%s)", (_label, make) => {
  it("binning the source bins its conclusions; restoring brings them back together; purging erases them together", async () => {
    const { inner, store } = setup(make, { bin: true });
    if (!isRecentlyDeletedCapable(store)) throw new Error("no bin");
    const bin = store as MemoryStore & RecentlyDeletedCapable;
    const { source, d1, d2 } = await chain(inner);

    await bin.deleteNode(source.nodeId);
    for (const id of [source.nodeId, d1.nodeId, d2.nodeId]) expect((await inner.getNode(id))!.retentionTier).toBe("PendingDeletion");
    const withRoot = (id: string) => ((inner.getNode(id) as Promise<{ contextualMetadata: Record<string, unknown> } | undefined>).then((n) => (n!.contextualMetadata[DELETION_REQUEST] as { with?: string }).with));
    expect(await withRoot(d1.nodeId)).toBe(source.nodeId);
    expect(await withRoot(d2.nodeId)).toBe(source.nodeId);

    // A conclusion cannot come back without the fact it rests on.
    await expect(bin.restoreDeleted(d1.nodeId)).rejects.toThrow(source.nodeId);

    await bin.restoreDeleted(source.nodeId);
    for (const id of [source.nodeId, d1.nodeId, d2.nodeId]) expect((await inner.getNode(id))!.retentionTier).toBe("FullRetention");

    await bin.deleteNode(source.nodeId);
    const r = await bin.purgeDeleted({ nodeIds: [source.nodeId], immediately: true });
    expect(r.purged).toEqual([source.nodeId]);
    for (const id of [source.nodeId, d1.nodeId, d2.nodeId]) expect(await inner.getNode(id)).toBeUndefined();
  });

  it("a purge that runs over everything erases a conclusion with its fact, not on its own", async () => {
    const { inner, store } = setup(make, { bin: true });
    const bin = store as MemoryStore & RecentlyDeletedCapable;
    const { source, d1 } = await chain(inner);
    await bin.deleteNode(source.nodeId);
    const r = await bin.purgeDeleted({ nodeIds: [source.nodeId, d1.nodeId], immediately: true });
    expect(r.purged).toEqual([source.nodeId]);
    expect(await inner.getNode(d1.nodeId)).toBeUndefined();
  });
});

describe.each(stores)("a source that stops being true, on a governed handle (%s)", (_label, make) => {
  it("updateNode with validTo retracts the conclusions and names them in the audit", async () => {
    const { inner, audit, store } = setup(make);
    const { source, d1, d2 } = await chain(inner);
    await store.updateNode(source.nodeId, { validTo: "2026-09-01T00:00:00.000Z" });
    for (const id of [d1.nodeId, d2.nodeId]) {
      const n = (await inner.getNode(id))!;
      expect(n.validTo).toBe("2026-09-01T00:00:00.000Z");
      expect(n.contextualMetadata["retraction"]).toMatchObject({ by: "invalidation" });
    }
    const update = audit.events.filter((e) => e.purpose === "invalidate" && e.outcome === "allowed").at(-1)!;
    expect(update.nodeIds.sort()).toEqual([source.nodeId, d1.nodeId, d2.nodeId].sort());
  });

  it("the MCP invalidate tool retracts them too, and keeps their words", async () => {
    const { inner, store } = setup(make);
    const tools = governanceTools({ store });
    const saved = await tools.remember({ text: "Works at the Tokyo office" });
    const d1 = await inner.addNode(makeDerived([saved.id], { content: { text: "Commutes in Tokyo" } }));
    await tools.invalidate({ id: saved.id, reason: "moved to Berlin" });
    const n = (await inner.getNode(d1.nodeId))!;
    expect(n.content.text).toBe("Commutes in Tokyo");
    expect(n.validTo).not.toBeNull();
    expect(n.contextualMetadata["retraction"]).toMatchObject({ by: "invalidation" });
  });
});
