/**
 * The same facts, policies and selector give the same receipt on every store —
 * SQLite (the default), Postgres (PGlite here) and in-memory — and the receipt
 * checks out against each store's own audit chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { makeDerived } from "../derived-conformance.spec.js";
import { InMemoryStore } from "../in-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { MemoryAudit, storeAudit, type AuditCapable } from "./audit.js";
import { verifyErasureReceipt, type ErasureReceipt, type ErasureSelector } from "./erasure.js";
import { govern } from "./governed-store.js";
import type { GovernancePolicy } from "./policy.js";
import { guardianMode, personalDefaults } from "./samples.js";

let pg: PGlite;
let tenant = 0;
beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
});
afterAll(async () => {
  await pg.close();
});

const makers: Record<string, () => Promise<MemoryStore>> = {
  sqlite: async () => new SqliteMemoryStore(":memory:", { auditKey: "k" }),
  postgres: async () => {
    const store = new PostgresMemoryStore({ tenantId: `erase-parity-${++tenant}`, client: pg, auditKey: "k" });
    await store.initialize();
    return store;
  },
  "in-memory": async () => new InMemoryStore(),
};

const T0 = new Date("2026-10-07T12:00:00.000Z");

function fixed(id: string, node: ReturnType<typeof makeNode>, day: number): MemoryNode {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return { ...node, nodeId: id, temporalAnchors: [{ event: "created", timestamp: at }], validFrom: at, validTo: null };
}

/** p42 facts, one a guardian's, conclusions two deep, and facts that must survive. */
const FACTS: MemoryNode[] = [
  fixed("f1", makeNode({ content: { text: "Person 42 prefers email" }, contextualMetadata: { subject: "p42" }, provenance: "UserInput" }), 1),
  fixed("f2", makeNode({ content: { text: "Person 42 and 43 share a flat" }, contextualMetadata: { subject: ["p42", "p43"] }, provenance: "UserInput" }), 2),
  fixed("f3", makeNode({ content: { text: "Guardian: person 42 needs a ramp" }, contextualMetadata: { subject: "p42" }, provenance: "GuardianAdded" }), 3),
  fixed("f4", makeNode({ content: { text: "Person 43 prefers phone" }, contextualMetadata: { subject: "p43" }, provenance: "UserInput" }), 4),
  fixed("f5", makeNode({ content: { text: "Archived note on person 42" }, contextualMetadata: { subject: "p42" }, provenance: "UserInput", retentionTier: "Archived" }), 5),
  fixed("f6", makeNode({ content: { text: "Unlabelled" }, contextualMetadata: {}, provenance: "UserInput" }), 6),
  fixed("d1", makeDerived(["f1"]), 7),
  fixed("d2", makeDerived(["d1"]), 8),
  fixed("d3", makeDerived(["f4"]), 9),
];

const SELECTOR: ErasureSelector = { label: "subject", equals: "p42" };

async function run(name: string, opts: { bin?: boolean; policies?: GovernancePolicy[] } = {}) {
  const inner = await makers[name]!();
  for (const node of FACTS) await inner.restoreNode(node);
  const auditCapable = name !== "in-memory";
  const store = govern(inner, {
    policies: [personalDefaults({ owner: "o" }), guardianMode({ guardians: ["g"] }), ...(opts.policies ?? [])],
    context: () => ({ actor: "o", now: T0 }),
    audit: auditCapable ? storeAudit(inner as MemoryStore & AuditCapable) : new MemoryAudit(),
    ...(opts.bin ? { recentlyDeleted: { days: 14 } } : {}),
  });
  const receipt = await store.eraseWhere(SELECTOR);
  const left = (await inner.listNodes()).map((n) => `${n.nodeId}:${n.retentionTier}`).sort();
  return { inner, receipt, left };
}

const outcome = (r: ErasureReceipt) => ({ matched: r.matched, erased: r.erased, refused: r.refused, held: r.heldInRecentlyDeleted, outside: r.outside, selector: r.selector });

describe("eraseWhere parity: SQLite, Postgres (PGlite), in-memory", () => {
  it("erases the same facts and writes the same receipt on every store", async () => {
    const results = await Promise.all(Object.keys(makers).map((name) => run(name)));
    const [first, ...rest] = results;
    expect(first!.left).toEqual(["f3:FullRetention", "f4:FullRetention", "f6:FullRetention", "d3:FullRetention"].sort());
    expect(first!.receipt).toMatchObject({ matched: 4, erased: { count: 5, matched: 3, concluded: 2 }, refused: { count: 1 } });
    for (const other of rest) {
      expect(other.left).toEqual(first!.left);
      expect(outcome(other.receipt)).toEqual(outcome(first!.receipt));
    }
  });

  it("holds the same facts in Recently deleted on every store", async () => {
    const results = await Promise.all(Object.keys(makers).map((name) => run(name, { bin: true })));
    const [first, ...rest] = results;
    expect(first!.receipt.heldInRecentlyDeleted.count).toBe(5);
    expect(first!.receipt.erased.count).toBe(0);
    for (const other of rest) {
      expect(other.left).toEqual(first!.left);
      expect(outcome(other.receipt)).toEqual(outcome(first!.receipt));
    }
  });

  it("the receipt checks out against SQLite's and Postgres's own chains, and a tampered chain fails it", async () => {
    for (const name of ["sqlite", "postgres"]) {
      const { inner, receipt } = await run(name);
      const store = inner as SqliteMemoryStore | PostgresMemoryStore;
      expect(await verifyErasureReceipt(receipt, store)).toMatchObject({ ok: true });
      expect(await verifyErasureReceipt(receipt, store, { head: await store.auditHead() })).toMatchObject({ ok: true });
      expect(await verifyErasureReceipt(receipt, store, { head: "0".repeat(64) })).toMatchObject({ ok: false });
    }
    const { inner, receipt } = await run("postgres");
    const pgStore = inner as PostgresMemoryStore;
    await pg.query("UPDATE memory_audit_events SET event = jsonb_set(event, '{count}', '0'::jsonb) WHERE tenant_key = $1 AND event ? 'receipt'", [pgStore.tenantId]);
    expect(await verifyErasureReceipt(receipt, pgStore)).toMatchObject({ ok: false, reason: expect.stringMatching(/edited/) });
  });
});
