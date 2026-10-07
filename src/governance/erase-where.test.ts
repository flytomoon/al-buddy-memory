/**
 * Erasure by label with a receipt: every fact carrying the selector's labels
 * goes through the same erase policies as `deleteNode`, what is allowed is
 * erased with everything concluded from it, and the receipt — counts, hashed
 * ids, reasons, and what it does not reach — is chained into the audit trail.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeDerived } from "../derived-conformance.spec.js";
import { InMemoryStore } from "../in-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { ChainedAudit, MemoryAudit, storeAudit, type AuditSink } from "./audit.js";
import { erasedIdHash, isSubjectErasureCapable, verifyErasureReceipt, type ErasureReceipt, type ErasureSelector } from "./erasure.js";
import { exportView, govern, isRecentlyDeletedCapable } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";
import { guardianMode, memoryLock, personalDefaults } from "./samples.js";

const T0 = new Date("2026-10-07T12:00:00.000Z");
const SUBJECT: ErasureSelector = { label: "subject", equals: "person-42" };

const stores: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

const labelled = (text: string, labels: Record<string, unknown>, extra: Parameters<typeof makeNode>[0] = {}) =>
  makeNode({ content: { text }, contextualMetadata: labels, provenance: "UserInput", ...extra });

function setup(make: () => MemoryStore, opts: { policies?: GovernancePolicy[]; bin?: boolean; actor?: string; audience?: string; audit?: AuditSink | null } = {}) {
  const inner = make();
  const audit = new MemoryAudit();
  const sink = opts.audit === null ? undefined : (opts.audit ?? audit);
  const store = govern(inner, {
    policies: [personalDefaults({ owner: "o" }), ...(opts.policies ?? [])],
    context: () => ({ actor: opts.actor ?? "o", audience: opts.audience, now: T0 }),
    audit: sink,
    ...(opts.bin ? { recentlyDeleted: { days: 30 } } : {}),
  });
  return { inner, audit, store };
}

async function seed(inner: MemoryStore) {
  const a = await inner.addNode(labelled("Person 42 prefers email", { subject: "person-42" }));
  const b = await inner.addNode(labelled("Person 42 lives in Lisbon", { subject: ["person-42", "household-7"] }));
  const c = await inner.addNode(labelled("Person 43 prefers phone", { subject: "person-43" }));
  const d = await inner.addNode(labelled("Office closes at 6", {}));
  const conclusion = await inner.addNode(makeDerived([a.nodeId]));
  const deeper = await inner.addNode(makeDerived([conclusion.nodeId]));
  return { a, b, c, d, conclusion, deeper };
}

const ids = (nodes: MemoryNode[]) => nodes.map((n) => n.nodeId).sort();

describe.each(stores)("eraseWhere (%s)", (_label, make) => {
  it("erases every fact carrying the labels, and what was concluded from them, and nothing else", async () => {
    const { inner, store } = setup(make);
    const { a, b, c, d, conclusion, deeper } = await seed(inner);
    expect(isSubjectErasureCapable(store)).toBe(true);
    const receipt = await store.eraseWhere(SUBJECT);
    for (const n of [a, b, conclusion, deeper]) expect(await inner.getNode(n.nodeId)).toBeUndefined();
    expect(ids(await inner.listNodes())).toEqual(ids([c, d]));
    expect(receipt.matched).toBe(2);
    expect(receipt.erased).toMatchObject({ count: 4, matched: 2, concluded: 2 });
    expect(receipt.erased.ids).toEqual([a, b, conclusion, deeper].map((n) => erasedIdHash(n.nodeId)).sort());
    expect(receipt.refused).toEqual({ count: 0, facts: [] });
    expect(receipt.heldInRecentlyDeleted).toEqual({ count: 0, facts: [] });
  });

  it("the receipt names the selector, the actor and the time, and never a raw id", async () => {
    const { inner, store } = setup(make);
    const { a, b, conclusion, deeper } = await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    expect(receipt.format).toBe("al-buddy-memory/erasure-receipt@1");
    expect(receipt.selector).toEqual(SUBJECT);
    expect(receipt.actor).toBe("o");
    expect(receipt.at).toBe(T0.toISOString());
    const text = JSON.stringify(receipt);
    for (const n of [a, b, conclusion, deeper]) expect(text).not.toContain(n.nodeId);
    expect(erasedIdHash(a.nodeId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("says plainly that backups and earlier exports are outside it", async () => {
    const { inner, store } = setup(make);
    await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    const outside = receipt.outside.join("\n");
    expect(outside).toMatch(/backups?/i);
    expect(outside).toMatch(/exports?/i);
    expect(outside).toMatch(/cannot see/i);
    expect(outside).toMatch(/labels/i);
  });

  it("a memory lock refuses every fact: nothing is erased, and each refusal is counted with its reason", async () => {
    const { inner, store, audit } = setup(make, { policies: [memoryLock()] });
    const { a, b } = await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    expect(await inner.listNodes()).toHaveLength(6);
    expect(receipt.erased.count).toBe(0);
    expect(receipt.refused.count).toBe(2);
    expect(receipt.refused.facts.map((f) => f.id)).toEqual([a, b].map((n) => erasedIdHash(n.nodeId)).sort());
    for (const f of receipt.refused.facts) {
      expect(f.policy).toBe("memory-lock");
      expect(f.reason).toMatch(/locked/);
    }
    expect(audit.events.filter((e) => e.outcome === "denied" && e.purpose === "erase")).toHaveLength(2);
  });

  it("a refusal on one fact leaves it, and the others are still erased", async () => {
    const { inner, store } = setup(make, { policies: [guardianMode({ guardians: ["g"] })] });
    const kept = await inner.addNode(labelled("Guardian note about person 42", { subject: "person-42" }, { provenance: "GuardianAdded" }));
    const gone = await inner.addNode(labelled("Person 42 likes tea", { subject: "person-42" }));
    const receipt = await store.eraseWhere(SUBJECT);
    expect(await inner.getNode(kept.nodeId)).toBeDefined();
    expect(await inner.getNode(gone.nodeId)).toBeUndefined();
    expect(receipt).toMatchObject({ matched: 2, erased: { count: 1 }, refused: { count: 1 } });
    expect(receipt.refused.facts[0]).toMatchObject({ id: erasedIdHash(kept.nodeId), policy: "guardian-mode" });
  });

  it("a fact is refused when a conclusion drawn from it may not be erased, and the reason holds no raw id", async () => {
    const guardConclusions: GovernancePolicy = {
      name: "keep-conclusions",
      beforeErase: (subject) => {
        if ("node" in subject && subject.node.provenance === "AIInferred") throw new PolicyDenied("keep-conclusions", "conclusions are kept");
      },
    };
    const { inner, store } = setup(make, { policies: [guardConclusions] });
    const { a, b, conclusion, deeper } = await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    expect(await inner.getNode(a.nodeId)).toBeDefined();
    expect(await inner.getNode(b.nodeId)).toBeUndefined();
    expect(receipt.refused.facts).toHaveLength(1);
    const { reason } = receipt.refused.facts[0]!;
    expect(reason).toContain(erasedIdHash(a.nodeId));
    expect([erasedIdHash(conclusion.nodeId), erasedIdHash(deeper.nodeId)].some((h) => reason.includes(h))).toBe(true);
    for (const n of [a, conclusion, deeper]) expect(reason).not.toContain(n.nodeId);
  });

  it("with Recently deleted, allowed facts are held (with their conclusions), not erased, and say when they become final", async () => {
    const { inner, store } = setup(make, { bin: true });
    const { a, b, conclusion, deeper } = await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    for (const n of [a, b, conclusion, deeper]) expect((await inner.getNode(n.nodeId))?.retentionTier).toBe("PendingDeletion");
    expect(receipt.erased.count).toBe(0);
    expect(receipt.heldInRecentlyDeleted.count).toBe(4);
    expect(receipt.heldInRecentlyDeleted.facts.map((f) => f.id)).toEqual([a, b, conclusion, deeper].map((n) => erasedIdHash(n.nodeId)).sort());
    const final = new Date(T0.getTime() + 30 * 86_400_000).toISOString();
    for (const f of receipt.heldInRecentlyDeleted.facts) expect(f.finalAfter).toBe(final);
    // The bin still works as it always did: purging makes it final.
    if (!isRecentlyDeletedCapable(store)) throw new Error("expected Recently deleted");
    await store.purgeDeleted({ nodeIds: [a.nodeId, b.nodeId], immediately: true });
    for (const n of [a, b, conclusion, deeper]) expect(await inner.getNode(n.nodeId)).toBeUndefined();
  });

  it("a fact already waiting in Recently deleted keeps its first clock", async () => {
    const { inner, store } = setup(make, { bin: true });
    const { a } = await seed(inner);
    await store.deleteNode(a.nodeId);
    const before = await inner.getNode(a.nodeId);
    const receipt = await store.eraseWhere(SUBJECT);
    expect((await inner.getNode(a.nodeId))?.contextualMetadata).toEqual(before?.contextualMetadata);
    expect(receipt.heldInRecentlyDeleted.facts.map((f) => f.id)).toContain(erasedIdHash(a.nodeId));
  });

  it("facts the actor cannot see are neither erased nor counted", async () => {
    // Erase rights for everyone, so only visibility decides.
    const allowAll: GovernancePolicy = { name: "anyone-erases", beforeErase: () => true };
    const inner = make();
    const sensitive = await inner.addNode(labelled("Person 42's diagnosis", { subject: "person-42" }, { privacyClassification: "Sensitive" }));
    const plain = await inner.addNode(labelled("Person 42 prefers email", { subject: "person-42" }));
    const store = govern(inner, {
      policies: [allowAll, { name: "hide", beforeRead: (n) => (n.privacyClassification === "Sensitive" ? null : n) }],
      context: () => ({ actor: "agent", now: T0 }),
      audit: new MemoryAudit(),
    });
    const receipt = await store.eraseWhere(SUBJECT);
    expect(await inner.getNode(sensitive.nodeId)).toBeDefined();
    expect(await inner.getNode(plain.nodeId)).toBeUndefined();
    expect(receipt.matched).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(erasedIdHash(sensitive.nodeId));
  });

  it("is chained into the audit trail: one event carries the receipt's digest", async () => {
    const { inner, store, audit } = setup(make);
    await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    const attesting = audit.events.filter((e) => e.receipt === receipt.digest);
    expect(attesting).toHaveLength(1);
    expect(attesting[0]).toMatchObject({ actor: "o", purpose: "erase", outcome: "allowed", at: receipt.at, count: receipt.erased.count, nodeIds: [] });
    // Each erasure also has its own event, naming the receipt it was part of.
    expect(audit.events.filter((e) => e.purpose === "erase" && e.outcome === "allowed" && e.receipt === undefined && e.reason?.includes(receipt.id))).toHaveLength(2);
  });

  it("matches with the boundary language: membership, AND, OR", async () => {
    const { inner, store } = setup(make);
    const x = await inner.addNode(labelled("x", { subject: "p1", region: "eu" }));
    const y = await inner.addNode(labelled("y", { subject: "p1", region: "us" }));
    const z = await inner.addNode(labelled("z", { subject: "p2", region: "eu" }));
    const w = await inner.addNode(labelled("w", { subject: "p3" }));
    const receipt = await store.eraseWhere({ any: [{ all: [{ label: "subject", in: ["p1"] }, { label: "region", equals: "eu" }] }, { label: "subject", equals: "p3" }] });
    expect(receipt.erased.ids).toEqual([x, w].map((n) => erasedIdHash(n.nodeId)).sort());
    expect(ids(await inner.listNodes())).toEqual(ids([y, z]));
  });

  it("refuses a selector that is malformed, names an actor attribute, or matches everything", async () => {
    const { inner, store } = setup(make);
    await seed(inner);
    for (const bad of [
      {},
      { label: "subject" },
      { label: "", equals: "x" },
      { label: "subject", equals: { actor: "id" } },
      { label: "subject", in: { actor: "ids" } },
      { all: [] },
      { any: [] },
      { all: [{ label: "subject", equals: "person-42" }, { all: [] }] },
      { label: "subject", equals: "x", extra: 1 },
    ]) {
      await expect(store.eraseWhere(bad as never)).rejects.toThrow(/selector/);
    }
    expect(await inner.listNodes()).toHaveLength(6);
  });

  it("needs an audit sink: a receipt with no trail to chain into is refused before anything is erased", async () => {
    const { inner, store } = setup(make, { audit: null });
    await seed(inner);
    await expect(store.eraseWhere(SUBJECT)).rejects.toThrow(/audit/);
    expect(await inner.listNodes()).toHaveLength(6);
  });

  it("refuses an actor the erase policies refuse, fact by fact, without erasing anything", async () => {
    // personalDefaults: only the owner, in person, erases.
    const { inner, store } = setup(make, { audience: "assistant" });
    await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    expect(receipt.erased.count).toBe(0);
    expect(receipt.refused.count).toBe(2);
    expect(receipt.refused.facts[0]!.policy).toBe("personal-defaults");
    expect(await inner.listNodes()).toHaveLength(6);
  });

  it("an export view refuses it", async () => {
    const inner = make();
    await seed(inner);
    const view = exportView(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) }) as unknown as { eraseWhere(s: ErasureSelector): Promise<ErasureReceipt> };
    await expect(view.eraseWhere(SUBJECT)).rejects.toThrow(/read-only/);
    expect(await inner.listNodes()).toHaveLength(6);
  });

  it("a receipt checks out against a chained trail, and an edited receipt does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "erase-where-"));
    try {
      const log = join(dir, "audit.jsonl");
      const { inner, store } = setup(make, { audit: new ChainedAudit(log, { key: "k" }) });
      await seed(inner);
      const receipt = await store.eraseWhere(SUBJECT);
      expect(await verifyErasureReceipt(receipt, log, { key: "k" })).toMatchObject({ ok: true });
      const edited = { ...receipt, erased: { ...receipt.erased, count: 99 } };
      expect(await verifyErasureReceipt(edited, log, { key: "k" })).toMatchObject({ ok: false, reason: expect.stringMatching(/edited/) });
      // A receipt sealed with a fresh digest but never recorded is not in the trail.
      const forged = await import("./erasure.js").then((m) => m.sealReceipt({ ...receipt, digest: undefined, erased: { ...receipt.erased, count: 99 } } as never));
      expect(await verifyErasureReceipt(forged, log, { key: "k" })).toMatchObject({ ok: false, reason: expect.stringMatching(/no event/) });
      expect(await verifyErasureReceipt(receipt, log, { key: "wrong" })).toMatchObject({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("eraseWhere on SQLite's own audit table", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("verify-audit checks the receipt in the database file, and the store checks it too", async () => {
    dir = mkdtempSync(join(tmpdir(), "erase-where-db-"));
    const path = join(dir, "memory.db");
    const inner = new SqliteMemoryStore(path, { auditKey: "k" });
    const store = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", now: T0 }), audit: storeAudit(inner) });
    await seed(inner);
    const receipt = await store.eraseWhere(SUBJECT);
    expect(await verifyErasureReceipt(receipt, inner)).toMatchObject({ ok: true });
    inner.close();
    const checked = await verifyErasureReceipt(receipt, path, { key: "k" });
    expect(checked).toMatchObject({ ok: true });
    expect(await verifyErasureReceipt(receipt, path, { key: "k", head: "0".repeat(64) })).toMatchObject({ ok: false });
  });
});
