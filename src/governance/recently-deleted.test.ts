import { describe, expect, it } from "vitest";

import { isHistoryCapable } from "../history.js";
import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryStore } from "../types/memory.js";
import { MemoryAudit } from "./audit.js";
import { DELETION_REQUEST, govern, isRecentlyDeletedCapable, type RecentlyDeletedCapable } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";
import { personalDefaults } from "./samples.js";

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const };
const fact = (text: string, extra: Record<string, unknown> = {}) => ({ ...base, provenance: "UserInput" as const, content: { text }, ...extra });

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-01T12:00:00.000Z");

const stores: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

function setup(make: () => MemoryStore, extraPolicies: GovernancePolicy[] = []) {
  const inner = make();
  const who = { actor: "o", now: new Date(T0) };
  const audit = new MemoryAudit();
  const store = govern(inner, {
    policies: [personalDefaults({ owner: "o" }), ...extraPolicies],
    context: () => ({ actor: who.actor, now: who.now }),
    audit,
    recentlyDeleted: { days: 14 },
  });
  if (!isRecentlyDeletedCapable(store)) throw new Error("Recently deleted is missing from the handle");
  return { inner, who, audit, store: store as MemoryStore & RecentlyDeletedCapable };
}

describe.each(stores)("Recently deleted (%s)", (_label, make) => {
  it("a delete moves the fact out of recall for the grace period instead of destroying it", async () => {
    const { inner, store, audit } = setup(make);
    const a = await store.addNode(fact("the spare key is under the blue pot"));
    await store.deleteNode(a.nodeId);

    const kept = await inner.getNode(a.nodeId);
    expect(kept?.retentionTier).toBe("PendingDeletion");
    expect(await store.searchNodes({ query: "spare key" })).toEqual([]);
    const listed = await store.listDeleted();
    expect(listed.map((d) => [d.node.nodeId, d.requestedAt, d.finalAfter])).toEqual([
      [a.nodeId, new Date(T0).toISOString(), new Date(T0 + 14 * DAY).toISOString()],
    ]);
    expect(audit.events.some((e) => e.purpose === "erase" && e.outcome === "allowed" && e.reason?.includes("Recently deleted"))).toBe(true);
  });

  it("restores a fact exactly to the tier it came from, and it is found again", async () => {
    const { store } = setup(make);
    const a = await store.addNode(fact("dentist on Thursdays"));
    const archived = await store.addNode(fact("old address", { retentionTier: "Archived" }));
    await store.deleteNode(a.nodeId);
    await store.deleteNode(archived.nodeId);

    const back = await store.restoreDeleted(a.nodeId);
    expect(back.retentionTier).toBe("FullRetention");
    expect(back.contextualMetadata[DELETION_REQUEST]).toBeUndefined();
    expect((await store.restoreDeleted(archived.nodeId)).retentionTier).toBe("Archived");
    expect((await store.searchNodes({ query: "dentist" })).map((n) => n.nodeId)).toEqual([a.nodeId]);
    expect(await store.listDeleted()).toEqual([]);
    await expect(store.restoreDeleted(a.nodeId)).rejects.toThrow(/not in Recently deleted/);
  });

  it("purges only once the days are up, and erasure takes the fact's history with it", async () => {
    const { inner, who, store } = setup(make);
    const a = await store.addNode(fact("temporary note"));
    await store.updateNode(a.nodeId, { confidenceWeight: 0.8 });
    await store.deleteNode(a.nodeId);

    who.now = new Date(T0 + 14 * DAY - 1);
    expect(await store.purgeDeleted()).toEqual({ purged: [], waiting: [a.nodeId], refused: [] });
    expect(await inner.getNode(a.nodeId)).toBeDefined();

    who.now = new Date(T0 + 14 * DAY);
    expect(await store.purgeDeleted()).toEqual({ purged: [a.nodeId], waiting: [], refused: [] });
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
    if (isHistoryCapable(inner)) expect(await inner.history(a.nodeId)).toEqual([]);
  });

  it("asks the erase policies again at purge time: a lock put on since then keeps the fact", async () => {
    let locked = false;
    const lock: GovernancePolicy = { name: "lock", beforeErase: () => { if (locked) throw new PolicyDenied("lock", "locked"); } };
    const { inner, who, store } = setup(make, [lock]);
    const a = await store.addNode(fact("keep me"));
    await store.deleteNode(a.nodeId);
    locked = true;
    who.now = new Date(T0 + 30 * DAY);
    expect(await store.purgeDeleted()).toEqual({ purged: [], waiting: [], refused: [a.nodeId] });
    expect((await inner.getNode(a.nodeId))?.retentionTier).toBe("PendingDeletion");
  });

  it("a second delete keeps the first request and its clock", async () => {
    const { who, store } = setup(make);
    const a = await store.addNode(fact("twice"));
    await store.deleteNode(a.nodeId);
    who.now = new Date(T0 + 10 * DAY);
    await store.deleteNode(a.nodeId);
    expect((await store.listDeleted())[0]?.requestedAt).toBe(new Date(T0).toISOString());
  });

  it("someone the owner's rules refuse can neither restore nor purge", async () => {
    const { inner, who, store } = setup(make);
    const a = await store.addNode(fact("owner's"));
    await store.deleteNode(a.nodeId);
    who.actor = "stranger";
    await expect(store.restoreDeleted(a.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    who.now = new Date(T0 + 30 * DAY);
    expect((await store.purgeDeleted()).refused).toEqual([a.nodeId]);
    expect(await inner.getNode(a.nodeId)).toBeDefined();
  });

  it("a fact put in PendingDeletion some other way is never purged on a clock, only by id, immediately", async () => {
    const { inner, who, store } = setup(make);
    const a = await store.addNode(fact("marked by another tool"));
    await inner.updateNode(a.nodeId, { retentionTier: "PendingDeletion" });
    who.now = new Date(T0 + 365 * DAY);
    expect(await store.purgeDeleted()).toEqual({ purged: [], waiting: [a.nodeId], refused: [] });
    expect((await store.listDeleted())[0]?.finalAfter).toBeNull();
    expect(await store.purgeDeleted({ nodeIds: [a.nodeId], immediately: true })).toEqual({ purged: [a.nodeId], waiting: [], refused: [] });
  });

  it("purging by id, immediately, empties the bin at once", async () => {
    const { inner, store } = setup(make);
    const a = await store.addNode(fact("now please"));
    const b = await store.addNode(fact("not this one"));
    await store.deleteNode(a.nodeId);
    await store.deleteNode(b.nodeId);
    expect(await store.purgeDeleted({ nodeIds: [a.nodeId], immediately: true })).toEqual({ purged: [a.nodeId], waiting: [], refused: [] });
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
    expect(await inner.getNode(b.nodeId)).toBeDefined();
  });

  it("is off unless asked for: deleteNode erases at once and the extra methods are absent", async () => {
    const inner = make();
    const plain = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    expect(isRecentlyDeletedCapable(plain)).toBe(false);
    const a = await plain.addNode(fact("gone"));
    await plain.deleteNode(a.nodeId);
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
    expect(() => govern(make(), { policies: [], context: () => ({ actor: "o" }), recentlyDeleted: { days: -1 } })).toThrow(/days/);
  });
});
