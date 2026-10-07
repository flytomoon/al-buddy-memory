import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { PostgresMemoryStore } from "./postgres-memory-store.js";
import { makeNode, runMemoryStoreConformance } from "./memory-store-conformance.spec.js";
import { govern } from "./governance/governed-store.js";

let db: PGlite;
beforeAll(async () => { db = new PGlite({ extensions: { vector } }); await db.waitReady; });
afterAll(async () => { await db.close(); });

describe("PostgresMemoryStore", () => {
  it("isolates tenants and preserves invalidated facts, versions, and immutable raw text", async () => {
    const a = new PostgresMemoryStore({ tenantId: "a", client: db });
    const b = new PostgresMemoryStore({ tenantId: "b", client: db });
    await a.initialize();
    const first = await a.addNode(makeNode({ content: { text: "shared roadmap" } }));
    expect(await b.listNodes()).toEqual([]);
    await expect(a.updateNode(first.nodeId, { content: { text: "changed" } } as never)).rejects.toThrow();
    const before = (await db.query<{ row_order: string }>("SELECT row_order FROM memory_items WHERE tenant_key=$1 AND kind='node' AND id=$2", ["a", first.nodeId])).rows[0]?.row_order;
    const second = await a.updateNode(first.nodeId, { validTo: "2026-01-02T00:00:00Z" });
    expect(second.validTo).toBe("2026-01-02T00:00:00.000Z");
    expect((await a.getNode(first.nodeId))?.content.text).toBe("shared roadmap");
    expect(await a.history(first.nodeId)).toHaveLength(1);
    expect((await a.listNodes()).map(n => n.nodeId)).toEqual([first.nodeId]);
    expect((await db.query<{ row_order: string }>("SELECT row_order FROM memory_items WHERE tenant_key=$1 AND kind='node' AND id=$2", ["a", first.nodeId])).rows[0]?.row_order).toBe(before);
  });

  it("ranks keyword matches after privacy and tenant visibility", async () => {
    const a = new PostgresMemoryStore({ tenantId: "rank", client: db });
    const other = new PostgresMemoryStore({ tenantId: "other", client: db });
    await a.initialize();
    const one = await a.addNode(makeNode({ content: { text: "alpha" } }));
    const two = await a.addNode(makeNode({ content: { text: "alpha beta" } }));
    const before = (await a.searchNodes({ query: "alpha beta" })).map(n => n.nodeId);
    await a.addNode(makeNode({ content: { text: "alpha beta" }, privacyClassification: "Sealed" }));
    await other.addNode(makeNode({ content: { text: "alpha beta" } }));
    const hits = await a.searchNodes({ query: "alpha beta" });
    expect(hits.map(n => n.nodeId)).toEqual([two.nodeId, one.nodeId]);
    expect(hits.map(n => n.nodeId)).toEqual(before);
    expect((await a.searchNodes({ query: "alpha beta", privacyClassification: ["Sealed"] }))).toHaveLength(1);
  });

  it("persists edges, embeddings, and ordered versions across store objects", async () => {
    const first = new PostgresMemoryStore({ tenantId: "persist", client: db, indexedDimensions: 3 });
    await first.initialize();
    const a = await first.addNode(makeNode());
    const b = await first.addNode(makeNode());
    const edge = await first.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    await first.setEmbedding({ nodeId: a.nodeId, model: "tiny", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] });
    await first.updateNode(a.nodeId, { confidenceWeight: 0.8 });
    await first.updateNode(a.nodeId, { confidenceWeight: 0.6 });
    const second = new PostgresMemoryStore({ tenantId: "persist", client: db, indexedDimensions: 3 });
    expect((await second.history(a.nodeId)).map(v => v.after.confidenceWeight)).toEqual([0.8, 0.6]);
    expect((await second.getEdges(a.nodeId))[0]?.edgeId).toBe(edge.edgeId);
    expect((await second.listEmbeddings("tiny"))[0]?.vector).toEqual([1, 0, 0]);
    await first.setEmbedding({ nodeId: b.nodeId, model: "tiny", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [0, 1, 0] });
    expect((await second.searchSimilar("tiny", "1", [1, 0, 0], { limit: 1 }))[0]?.node.nodeId).toBe(a.nodeId);
    await second.updateNode(a.nodeId, { privacyClassification: "Sealed" });
    expect((await second.searchSimilar("tiny", "1", [1, 0, 0], { limit: 1 }))[0]?.node.nodeId).toBe(b.nodeId);
    await second.deleteNode(a.nodeId);
    expect(await second.getEdges(b.nodeId)).toEqual([]);
    expect(await second.getEmbeddings(a.nodeId)).toEqual([]);
  });

  it("commits a governed mutation with its chained audit event", async () => {
    const store = new PostgresMemoryStore({ tenantId: "audit", client: db });
    await store.initialize();
    const before = await store.auditHead();
    const node = await store.auditedMutation(
      () => store.addNode(makeNode()),
      result => ({ at: new Date().toISOString(), actor: "tester", purpose: "write", outcome: "allowed", nodeIds: [result.nodeId], count: 1 }),
    );
    expect(await store.getNode(node.nodeId)).toBeDefined();
    expect(await store.auditHead()).not.toBe(before);
    const rows = await db.query<{ event: unknown }>("SELECT event FROM memory_audit_events WHERE tenant_key=$1", ["audit"]);
    expect(rows.rows).toHaveLength(1);
    await db.query("DELETE FROM memory_audit_events WHERE tenant_key=$1", ["audit"]);
    await expect(store.auditedMutation(
      () => store.addNode(makeNode({ content: { text: "must roll back" } })),
      result => ({ at: new Date().toISOString(), actor: "tester", purpose: "write", outcome: "allowed", nodeIds: [result.nodeId], count: 1 }),
    )).rejects.toThrow(/audit chain broken/);
    expect((await store.listNodes()).map(n => n.nodeId)).toEqual([node.nodeId]);
  });

  it("verifyAudit checks a tenant's chain without writing anything, and catches a cut tail", async () => {
    const store = new PostgresMemoryStore({ tenantId: "verify", client: db, auditKey: "k" });
    await store.initialize();
    const event = { at: "2026-10-07T00:00:00.000Z", actor: "tester", purpose: "write" as const, outcome: "allowed" as const, nodeIds: [], count: 0 };
    await store.recordAuditEvent(event);
    await store.recordAuditEvent({ ...event, reason: "second" });
    const seen: number[] = [];
    expect(await store.verifyAudit({ visit: (_e, position) => seen.push(position) })).toEqual({ ok: true, count: 2, head: await store.auditHead() });
    expect(seen).toEqual([1, 2]);
    expect(await new PostgresMemoryStore({ tenantId: "verify", client: db, auditKey: "wrong" }).verifyAudit()).toMatchObject({ ok: false, reason: expect.stringMatching(/edited/) });

    const ghost = new PostgresMemoryStore({ tenantId: "no-such-tenant", client: db });
    expect(await ghost.verifyAudit()).toMatchObject({ ok: false, reason: expect.stringMatching(/no tenant/) });
    expect((await db.query("SELECT 1 FROM memory_tenants WHERE tenant_key=$1", ["no-such-tenant"])).rows).toHaveLength(0);

    await db.query("DELETE FROM memory_audit_events WHERE tenant_key=$1 AND seq = (SELECT MAX(seq) FROM memory_audit_events WHERE tenant_key=$1)", ["verify"]);
    expect(await store.verifyAudit()).toMatchObject({ ok: false, reason: expect.stringMatching(/removed from the end/) });
  });

  it("governed keyword order depends only on visible matches", async () => {
    const inner = new PostgresMemoryStore({ tenantId: "visible-rank", client: db });
    await inner.initialize();
    const visible = govern(inner, {
      policies: [{ name: "hide-flag", beforeRead: node => node.contextualMetadata["hide"] ? null : node }],
      context: () => ({ actor: "reader" }),
    });
    await inner.addNode(makeNode({ content: { text: "alpha alpha" } }));
    await inner.addNode(makeNode({ content: { text: "beta beta" } }));
    const before = (await visible.searchNodes({ query: "alpha beta" })).map(n => n.nodeId);
    for (let i = 0; i < 8; i++) await inner.addNode(makeNode({ content: { text: "alpha" }, contextualMetadata: { hide: true } }));
    expect((await visible.searchNodes({ query: "alpha beta" })).map(n => n.nodeId)).toEqual(before);
  });
});

runMemoryStoreConformance("Postgres", () => new PostgresMemoryStore({ tenantId: globalThis.crypto.randomUUID(), client: db }));
