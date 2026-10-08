/**
 * Security review of the enterprise surface, 2026-10 (docs/SECURITY-REVIEW-2026-10.md).
 * Each block is one finding, written as the failing test before its fix, on
 * every store: SQLite (the default), Postgres (PGlite) and in-memory.
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
import { MemoryAudit, storeAudit } from "./audit.js";
import { govern, isRecentlyDeletedCapable } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy, type PolicyContext } from "./policy.js";

let pg: PGlite;
let tenant = 0;
beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
});
afterAll(async () => {
  await pg.close();
});

const stores: [string, () => Promise<MemoryStore>][] = [
  ["sqlite", async () => new SqliteMemoryStore(":memory:")],
  [
    "postgres",
    async () => {
      const store = new PostgresMemoryStore({ tenantId: `review-${++tenant}`, client: pg });
      await store.initialize();
      return store;
    },
  ],
  ["in-memory", async () => new InMemoryStore()],
];

const labelled = (text: string, labels: Record<string, unknown>) => makeNode({ content: { text }, contextualMetadata: labels });
const ids = (nodes: MemoryNode[]) => nodes.map((n) => n.nodeId).sort();
const values = (ctx: PolicyContext, name: string): readonly string[] => {
  const v = ctx.attributes?.[name];
  return v === undefined ? [] : typeof v === "string" ? [v] : v;
};

/** A policy that strips one label and the tags from a fact for anyone outside one role. */
const redacting: GovernancePolicy = {
  name: "redacting",
  beforeRead(node, ctx) {
    if (values(ctx, "roles").includes("finance")) return node;
    const { rate: _rate, tags: _tags, ...rest } = node.contextualMetadata;
    return { ...node, contextualMetadata: rest };
  },
  beforeErase: () => true,
};

describe.each(stores)("a filter on a label a policy redacts (%s)", (_name, make) => {
  async function setup() {
    const inner = await make();
    const priced = await inner.addNode(labelled("Acme invoice", { client: "acme", rate: "120", tags: ["confidential"] }));
    const other = await inner.addNode(labelled("Acme invoice draft", { client: "acme", rate: "95" }));
    const as = (roles: string[]) =>
      govern(inner, { policies: [redacting], context: () => ({ actor: "a", attributes: { roles } }), audit: new MemoryAudit(), recentlyDeleted: { days: 30 } });
    return { inner, priced, other, staff: as([]), finance: as(["finance"]) };
  }

  it("does not confirm the redacted value to someone who cannot read it", async () => {
    const { priced, staff, finance } = await setup();
    const byRate = { labels: { label: "rate", in: ["120"] } } as const;
    expect(ids(await finance.searchNodes(byRate))).toEqual([priced.nodeId]);
    expect(await staff.searchNodes(byRate)).toEqual([]);
    expect(await staff.searchNodes({ ...byRate, limit: 1 })).toEqual([]);
    expect(await staff.searchNodes({ ...byRate, query: "invoice" })).toEqual([]);
    expect(await staff.searchNodes({ tags: ["confidential"] })).toEqual([]);
    expect(await staff.searchNodes({ tags: ["confidential"], limit: 1 })).toEqual([]);
    // What they can see still matches as before.
    expect(ids(await staff.searchNodes({ labels: { label: "client", in: ["acme"] }, limit: 5 }))).toHaveLength(2);
  });

  it("an erasure by it neither counts nor erases what it matched only through the redacted label", async () => {
    const { inner, priced, staff, finance } = await setup();
    const receipt = await staff.eraseWhere({ label: "rate", equals: "120" });
    expect(receipt.matched).toBe(0);
    expect(receipt.heldInRecentlyDeleted.count).toBe(0);
    expect((await inner.getNode(priced.nodeId))?.retentionTier).toBe("FullRetention");
    expect((await finance.eraseWhere({ label: "rate", equals: "120" })).matched).toBe(1);
    expect(isRecentlyDeletedCapable(finance)).toBe(true);
  });
});

/** Teams by label, and a legal hold no one may erase or retract through. */
const teams: GovernancePolicy = { name: "teams", readBoundary: { label: "team", in: { actor: "teams" } } };
const hold: GovernancePolicy = {
  name: "hold",
  beforeErase(subject) {
    if ("node" in subject && subject.node.contextualMetadata["hold"] !== undefined) throw new PolicyDenied("hold", `under legal hold ${String(subject.node.contextualMetadata["hold"])}`);
    return true;
  },
  beforeUpdate(existing, patch) {
    if (existing.contextualMetadata["hold"] !== undefined && patch.validTo != null) throw new PolicyDenied("hold", `under legal hold ${String(existing.contextualMetadata["hold"])}`);
  },
};

describe.each(stores)("a refusal caused by a conclusion the actor cannot see (%s)", (_name, make) => {
  async function setup() {
    const inner = await make();
    const root = await inner.addNode(labelled("Blue fact", { team: "blue" }));
    const hidden = await inner.addNode(makeDerived([root.nodeId], { contextualMetadata: { derivedFrom: [root.nodeId], team: "red", hold: "matter-7731" } }));
    const as = (actorTeams: string[]) => govern(inner, { policies: [teams, hold], context: () => ({ actor: "x", attributes: { teams: actorTeams } }), audit: new MemoryAudit() });
    return { inner, root, hidden, blue: as(["blue"]), both: as(["blue", "red"]) };
  }

  const refusal = async (p: Promise<unknown>): Promise<PolicyDenied> => {
    const err = await p.then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyDenied);
    return err as PolicyDenied;
  };

  it("still refuses an erase, without naming the hidden fact or the policy's reason about it", async () => {
    const { inner, root, hidden, blue, both } = await setup();
    const err = await refusal(blue.deleteNode(root.nodeId));
    expect(err.message).not.toContain(hidden.nodeId);
    expect(err.message).not.toContain("matter-7731");
    expect(await inner.getNode(root.nodeId)).toBeDefined();
    // Someone who can see it is told which fact stood in the way, as before.
    expect((await refusal(both.deleteNode(root.nodeId))).message).toContain(hidden.nodeId);
  });

  it("and the same for an invalidation that would retract it", async () => {
    const { root, hidden, blue } = await setup();
    const err = await refusal(blue.updateNode(root.nodeId, { validTo: "2026-10-01T00:00:00.000Z" }));
    expect(err.message).not.toContain(hidden.nodeId);
    expect(err.message).not.toContain("matter-7731");
  });

  it("and in an erasure receipt", async () => {
    const { root, blue } = await setup();
    const receipt = await blue.eraseWhere({ label: "team", equals: "blue" });
    expect(receipt.refused.count).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain("matter-7731");
    expect(await blue.getNode(root.nodeId)).toBeDefined();
  });
});

/*
 * Checked and held: these pass without a change, and stay as guards.
 */

describe.each(stores)("the boundary on history and as-of reads (%s)", (_name, make) => {
  it("withholds a hidden fact's versions, past states and links", async () => {
    const inner = await make();
    const mine = await inner.addNode(labelled("blue plan", { team: "blue" }));
    const theirs = await inner.addNode(labelled("red plan", { team: "red" }));
    await inner.addEdge({ sourceNodeId: mine.nodeId, targetNodeId: theirs.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    for (const n of [mine, theirs]) await inner.updateNode(n.nodeId, { confidenceWeight: 0.5 });
    const store = govern(inner, { policies: [teams], context: () => ({ actor: "ana", attributes: { teams: ["blue"] } }) });
    if (store.history === undefined || store.getNodeAsOf === undefined || store.historySnapshot === undefined || store.snapshotAsOf === undefined) throw new Error("not history-capable");
    expect(await store.history(mine.nodeId)).toHaveLength(1);
    expect(await store.history(theirs.nodeId)).toEqual([]);
    expect(await store.getNodeAsOf(theirs.nodeId, new Date().toISOString())).toBeUndefined();
    const snap = await store.historySnapshot();
    expect(ids(snap.nodes)).toEqual([mine.nodeId]);
    expect(snap.edges).toEqual([]);
    expect(new Set(snap.versions.map((v) => v.nodeId))).toEqual(new Set([mine.nodeId]));
    expect(JSON.stringify(await store.snapshotAsOf(new Date().toISOString()))).not.toContain(theirs.nodeId);
  });
});

/** Every row of one Postgres tenant's facts, links, versions and vectors, as text. */
async function pgRows(tenantId: string): Promise<string> {
  return JSON.stringify((await pg.query("SELECT kind, id, metadata::text AS m, content, embedding::text AS e FROM memory_items WHERE tenant_key = $1", [tenantId])).rows);
}
/** Every row of every SQLite table but the audit trail (which keeps ids by design), as text. */
function sqliteRows(store: SqliteMemoryStore): string {
  const db = (store as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
  const out: unknown[] = [];
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]) {
    if (name.includes("audit")) continue;
    try { out.push(name, db.prepare(`SELECT * FROM "${name}"`).all()); } catch { /* an FTS shadow table that cannot be read directly */ }
  }
  return JSON.stringify(out, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : typeof v === "bigint" ? String(v) : v));
}

describe.each(["postgres", "sqlite"])("an erasure by label leaves no copy in the live tables (%s)", (kind) => {
  it("of the fact, its conclusion, their versions, links and vectors", async () => {
    const tenantId = `erase-${++tenant}`;
    let inner: MemoryStore;
    let rows: () => Promise<string>;
    if (kind === "postgres") {
      const store = new PostgresMemoryStore({ tenantId, client: pg, indexedDimensions: 3 });
      await store.initialize();
      inner = store;
      rows = () => pgRows(tenantId);
    } else {
      const store = new SqliteMemoryStore(":memory:");
      inner = store;
      rows = async () => sqliteRows(store);
    }
    const root = await inner.addNode(labelled("zebracorn holds the key", { subject: "p1" }));
    const kept = await inner.addNode(labelled("unrelated note", {}));
    const conclusion = await inner.addNode(makeDerived([root.nodeId], { content: { text: "therefore unicornzebra" } }));
    const link = { relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" } as const;
    await inner.addEdge({ sourceNodeId: root.nodeId, targetNodeId: kept.nodeId, ...link });
    await inner.addEdge({ sourceNodeId: kept.nodeId, targetNodeId: conclusion.nodeId, ...link });
    for (const n of [root, conclusion]) {
      await inner.setEmbedding({ nodeId: n.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [0.1, 0.2, 0.3] });
      await inner.updateNode(n.nodeId, { confidenceWeight: 0.5 });
    }
    const store = govern(inner, { policies: [{ name: "erase", beforeErase: () => true }], context: () => ({ actor: "o" }), audit: storeAudit(inner as SqliteMemoryStore) });
    expect((await store.eraseWhere({ label: "subject", equals: "p1" })).erased.count).toBe(2);
    const left = await rows();
    for (const trace of [root.nodeId, conclusion.nodeId, "zebracorn", "unicornzebra"]) expect(left).not.toContain(trace);
    expect(left).toContain(kept.nodeId);
  });
});

describe("Postgres tenants, and hostile strings as data", () => {
  // Quotes, a statement terminator, a comment, jsonb operators and a placeholder.
  const EVIL = `x'); DROP TABLE memory_items; --"\\?|$1`;

  it("one tenant can neither read nor change another's facts, links, versions or vectors", async () => {
    const a = new PostgresMemoryStore({ tenantId: EVIL, client: pg, indexedDimensions: 3 });
    await a.initialize();
    const b = new PostgresMemoryStore({ tenantId: `${EVIL}b`, client: pg, indexedDimensions: 3 });
    const n = await a.addNode(makeNode({ content: { text: "alpha secret" }, contextualMetadata: { [EVIL]: EVIL, tags: [EVIL] } }));
    const m = await a.addNode(makeNode({ content: { text: "alpha other" } }));
    const edge = await a.addEdge({ sourceNodeId: n.nodeId, targetNodeId: m.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    const vec = { nodeId: n.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] } as const;
    await a.setEmbedding(vec);
    await a.updateNode(n.nodeId, { confidenceWeight: 0.5 });
    const version = (await a.history(n.nodeId))[0]!;

    expect(await b.getNode(n.nodeId)).toBeUndefined();
    expect(await b.getEdges(n.nodeId)).toEqual([]);
    expect(await b.history(n.nodeId)).toEqual([]);
    expect(await b.getEmbeddings(n.nodeId)).toEqual([]);
    expect(await b.listEmbeddings("m")).toEqual([]);
    expect(await b.searchNodes({ query: "alpha" })).toEqual([]);
    expect(await b.searchSimilar("m", "1", [1, 0, 0])).toEqual([]);
    expect(await b.nodesRestingOn([n.nodeId])).toEqual([]);
    await expect(b.setEmbedding({ ...vec, vector: [0, 1, 0] })).rejects.toThrow();
    await expect(b.addEdge({ sourceNodeId: n.nodeId, targetNodeId: m.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" })).rejects.toThrow();
    await expect(b.restoreEdge(edge)).rejects.toThrow();
    await expect(b.updateNode(n.nodeId, { confidenceWeight: 0.1 })).rejects.toThrow();
    await expect(b.restoreVersion(version)).rejects.toThrow();
    await b.deleteNode(n.nodeId).catch(() => undefined);
    await b.deleteEdge(edge.edgeId);
    await b.deleteEmbeddings(n.nodeId);
    await b.addNode(makeDerived([n.nodeId]));

    expect((await a.getNode(n.nodeId))?.confidenceWeight).toBe(0.5);
    expect(await a.getEdges(n.nodeId)).toHaveLength(1);
    expect(await a.getEmbeddings(n.nodeId)).toHaveLength(1);
    expect(await a.nodesRestingOn([n.nodeId])).toEqual([]);
  });

  it("a hostile label, value, tag or query is matched as data on Postgres and SQLite", async () => {
    const a = new PostgresMemoryStore({ tenantId: `evil-${++tenant}`, client: pg, indexedDimensions: 3 });
    await a.initialize();
    const n = await a.addNode(makeNode({ contextualMetadata: { [EVIL]: EVIL, tags: [EVIL] } }));
    await a.addNode(makeNode({ contextualMetadata: { x: "y" } }));
    await a.setEmbedding({ nodeId: n.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] });
    expect(ids(await a.searchNodes({ labels: { label: EVIL, in: [EVIL] } }))).toEqual([n.nodeId]);
    expect(ids(await a.searchNodes({ tags: [EVIL] }))).toEqual([n.nodeId]);
    expect(await a.searchNodes({ query: EVIL })).toEqual([]);
    expect((await a.searchSimilar("m", "1", [1, 0, 0], { labels: { label: EVIL, in: [EVIL] } })).map((r) => r.node.nodeId)).toEqual([n.nodeId]);
    const s = new SqliteMemoryStore(":memory:");
    const sn = await s.addNode(makeNode({ contextualMetadata: { [EVIL]: EVIL } }));
    expect(ids(await s.searchNodes({ labels: { label: EVIL, in: [EVIL] } }))).toEqual([sn.nodeId]);
    expect(await s.searchNodes({ query: EVIL })).toEqual([]);
  });
});
