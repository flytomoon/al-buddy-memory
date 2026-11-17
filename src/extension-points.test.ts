import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

import { InMemoryStore } from "./in-memory-store.js";
import { makeNode, runMemoryStoreConformance } from "./memory-store-conformance.spec.js";
import { runDerivedConformance } from "./derived-conformance.spec.js";
import { PostgresMemoryStore, poolExecutor, type PostgresQueryClient, type QueryExecutor, type StoreAccessEvent, type StoreAuditSink } from "./postgres-memory-store.js";
import { exportView, govern, inProcessLock, type LockProvider } from "./governance/governed-store.js";
import { MemoryAudit, storeAudit } from "./governance/audit.js";
import { PolicyDenied, type GovernancePolicy, type PolicyContext } from "./governance/policy.js";
import type { GovernedOperations } from "./governance/operations.js";
import { createGovernanceMcpServer, TOOL_ANNOTATIONS, type GovernanceDeps } from "./mcp/governance-server.js";
import type { MemoryNode } from "./types/memory.js";

/**
 * The extension points: a QueryExecutor under the Postgres store, an access
 * sink beside it, a LockProvider under `govern`. Each is left out by default,
 * and these tests hold the defaults to what the code did before they existed:
 * the same statements, the same results, the same queue.
 */

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  await new PostgresMemoryStore({ tenantId: "setup", client: db, indexedDimensions: 3 }).initialize();
  await db.query("CREATE TABLE access_log (tenant_key text NOT NULL, operation text NOT NULL)");
});
afterAll(async () => { await db.close(); });

const tenant = () => globalThis.crypto.randomUUID();

/** `db` as a client whose every statement, in or out of a transaction, is written to `log`. */
function recording(log: string[]): QueryExecutor & PostgresQueryClient {
  const wrap = (c: { query: PGlite["query"] }): PostgresQueryClient => ({
    query: (sql, values) => { log.push(sql); return c.query(sql, values); },
  });
  return { ...wrap(db), transaction: work => db.transaction(tx => work(wrap(tx))) };
}

/**
 * `db` as a node-postgres pool of one connection: what `poolExecutor` drives,
 * and what the store builds from a `connectionString`. Connections queue, as
 * they would for a pool whose `max` is 1.
 */
function onePool(calls: string[] = []) {
  let free: Promise<void> = Promise.resolve();
  return {
    query: (sql: string, values?: unknown[]) => db.query(sql, values),
    async connect() {
      let release!: () => void;
      const mine = new Promise<void>(r => (release = r));
      const prior = free;
      free = prior.then(() => mine);
      await prior;
      return {
        query: (sql: string, values?: unknown[]) => { calls.push(sql); return db.query(sql, values); },
        release: () => { calls.push("release"); release(); },
      };
    },
  };
}

/** One of everything, and what a caller sees of it (no ids or clocks, which differ run to run). */
async function exercise(s: PostgresMemoryStore) {
  await s.initialize();
  const a = await s.addNode(makeNode({ content: { text: "alpha one" } }));
  const b = await s.addNode(makeNode({ content: { text: "beta two" } }));
  const edge = await s.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
  await s.setEmbedding({ nodeId: a.nodeId, model: "tiny", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] });
  await s.updateNode(a.nodeId, { confidenceWeight: 0.5 });
  const seen = {
    get: (await s.getNode(a.nodeId))?.content.text,
    list: (await s.listNodes()).map(n => n.content.text),
    search: (await s.searchNodes({ query: "alpha" })).map(n => n.content.text),
    edges: (await s.getEdges(a.nodeId)).length,
    history: (await s.history(a.nodeId)).map(v => v.after.confidenceWeight),
    similar: (await s.searchSimilar("tiny", "1", [1, 0, 0])).map(h => h.node.content.text),
    embeddings: (await s.listEmbeddings("tiny")).length,
    snapshot: (await s.historySnapshot()).versions.length,
    resting: (await s.nodesRestingOn([a.nodeId])).length,
  };
  await s.deleteEdge(edge.edgeId);
  await s.deleteEmbeddings(b.nodeId);
  await s.updateNode(b.nodeId, { validTo: "2026-01-02T00:00:00Z" });
  await s.deleteNode(a.nodeId);
  return { ...seen, after: (await s.snapshot()).nodes.map(n => [n.content.text, n.validTo]) };
}

describe("QueryExecutor", () => {
  it("an executor runs exactly the statements the store ran on its client, and returns the same", async () => {
    const viaClient: string[] = [];
    const viaExecutor: string[] = [];
    const before = await exercise(new PostgresMemoryStore({ tenantId: tenant(), client: recording(viaClient), indexedDimensions: 3 }));
    const after = await exercise(new PostgresMemoryStore({ tenantId: tenant(), executor: recording(viaExecutor), indexedDimensions: 3 }));
    expect(after).toEqual(before);
    expect(viaExecutor).toEqual(viaClient);
    expect(viaExecutor.length).toBeGreaterThan(40);
  });

  it("every statement goes through it: given only an executor, the store has no other way to the database", async () => {
    const log: string[] = [];
    const id = tenant();
    const store = new PostgresMemoryStore({ tenantId: id, executor: recording(log), indexedDimensions: 3 });
    await exercise(store);
    await store.recordAuditEvent({ at: new Date().toISOString(), actor: "owner", purpose: "write", outcome: "allowed", nodeIds: [], count: 0 });
    expect((await store.verifyAudit()).ok).toBe(true);
    // Setup, ordinary transactions and the read-only snapshot alike.
    expect(log[0]).toBe("CREATE EXTENSION IF NOT EXISTS vector");
    expect(log).toContain("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(log).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // What it wrote is there for an ordinary store on the same database.
    expect((await new PostgresMemoryStore({ tenantId: id, client: db }).snapshot()).nodes.map(n => n.content.text)).toEqual(["beta two"]);
  });

  it("poolExecutor: one connection per transaction, BEGIN … COMMIT, ROLLBACK when the work throws, released either way", async () => {
    const calls: string[] = [];
    const executor = poolExecutor(onePool(calls) as never);
    expect((await executor.transaction(async c => (await c.query("SELECT 1 AS one")).rows[0].one))).toBe(1);
    expect(calls).toEqual(["BEGIN", "SELECT 1 AS one", "COMMIT", "release"]);
    calls.length = 0;
    await expect(executor.transaction(async () => { throw new Error("no"); })).rejects.toThrow("no");
    expect(calls).toEqual(["BEGIN", "ROLLBACK", "release"]);
    expect((await executor.query("SELECT 2 AS two")).rows[0].two).toBe(2);
  });

  it("a client without transaction() is refused with a reason, not a TypeError", async () => {
    const s = new PostgresMemoryStore({ tenantId: tenant(), client: { query: (sql, values) => db.query(sql, values) } });
    await expect(s.listNodes()).rejects.toThrow(/no transaction\(\).*poolExecutor/);
  });

  it("needs somewhere to send statements", () => {
    expect(() => new PostgresMemoryStore({ tenantId: "x" })).toThrow("connectionString, client or executor is required");
  });
});

// The pool path the store takes for a connectionString, through the whole suite.
runMemoryStoreConformance("Postgres through poolExecutor", () => new PostgresMemoryStore({ tenantId: tenant(), executor: poolExecutor(onePool() as never) }));
runDerivedConformance("Postgres through poolExecutor", () => new PostgresMemoryStore({ tenantId: tenant(), executor: poolExecutor(onePool() as never) }));

describe("StoreAuditSink", () => {
  const listening = (reads: boolean, record: StoreAuditSink["record"] = () => {}) => {
    const heard: StoreAccessEvent[] = [];
    const sink: StoreAuditSink = { record: (event, c) => { heard.push(event); return record(event, c); } };
    return { heard, store: new PostgresMemoryStore({ tenantId: tenant(), client: db, indexedDimensions: 3, accessAudit: { sink, reads } }) };
  };

  it("adds no statement and changes no result when it writes nothing itself", async () => {
    const plain: string[] = [];
    const heardLog: string[] = [];
    const before = await exercise(new PostgresMemoryStore({ tenantId: tenant(), client: recording(plain), indexedDimensions: 3 }));
    const sink: StoreAuditSink = { record() {} };
    const after = await exercise(new PostgresMemoryStore({ tenantId: tenant(), client: recording(heardLog), indexedDimensions: 3, accessAudit: { sink, reads: true } }));
    expect(after).toEqual(before);
    expect(heardLog).toEqual(plain);
  });

  it("hears every write, and no read unless reads are on", async () => {
    const { heard, store } = listening(false);
    await exercise(store);
    expect(heard.map(e => e.operation)).toEqual(["addNode", "addNode", "addEdge", "setEmbedding", "updateNode", "deleteEdge", "deleteEmbeddings", "updateNode", "deleteNode"]);
    expect(heard.every(e => e.access === "write" && e.tenantId === store.tenantId && !Number.isNaN(Date.parse(e.at)))).toBe(true);
    const [a, b] = heard;
    expect(heard[4]?.ids).toEqual(a?.ids);
    expect(heard[7]?.ids).toEqual(b?.ids);
  });

  it("with reads on, hears each read once, naming what it returned", async () => {
    const { heard, store } = listening(true);
    await store.initialize();
    const a = await store.addNode(makeNode({ content: { text: "gamma" } }));
    await store.setEmbedding({ nodeId: a.nodeId, model: "tiny", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [0, 1, 0] });
    heard.length = 0;
    await store.searchNodes({ query: "gamma" });
    await store.listNodes();
    await store.getNode(a.nodeId);
    await store.searchSimilar("tiny", "1", [0, 1, 0]);
    expect(heard.map(e => [e.access, e.operation, e.ids])).toEqual([
      ["read", "searchNodes", [a.nodeId]],
      ["read", "listNodes", [a.nodeId]],
      ["read", "getNode", [a.nodeId]],
      ["read", "searchSimilar", [a.nodeId]],
    ]);
    // setEmbedding checks the fact exists; that is part of the write, not a read of its own.
    heard.length = 0;
    await store.setEmbedding({ nodeId: a.nodeId, model: "tiny", modelVersion: "2", dimensions: 3, metric: "cosine", vector: [0, 1, 0] });
    expect(heard.map(e => e.operation)).toEqual(["setEmbedding"]);
  });

  it("records inside the call's transaction: what it writes commits with the call, and a throw rolls the call back", async () => {
    const { store } = listening(false, async (event, c) => {
      await c.query("INSERT INTO access_log VALUES($1,$2)", [event.tenantId, event.operation]);
      if (event.operation === "deleteNode") throw new Error("sink is down");
    });
    await store.initialize();
    const a = await store.addNode(makeNode());
    await expect(store.deleteNode(a.nodeId)).rejects.toThrow("sink is down");
    expect(await store.getNode(a.nodeId)).toBeDefined();
    expect((await db.query<{ operation: string }>("SELECT operation FROM access_log WHERE tenant_key=$1", [store.tenantId])).rows.map(r => r.operation)).toEqual(["addNode"]);
  });

  it("a governed mutation committed with its audit event is heard once", async () => {
    const { heard, store } = listening(true);
    await store.initialize();
    const governed = govern(store, { policies: [], context: () => ({ actor: "owner" }), audit: storeAudit(store) });
    heard.length = 0;
    await governed.addNode(makeNode());
    expect(heard.filter(e => e.access === "write").map(e => e.operation)).toEqual(["addNode"]);
  });
});

runMemoryStoreConformance("Postgres with an access sink hearing reads", () => new PostgresMemoryStore({ tenantId: tenant(), client: db, accessAudit: { sink: { record() {} }, reads: true } }));

describe("LockProvider", () => {
  const open: GovernancePolicy = { name: "open", beforeErase: () => true };
  const context = () => ({ actor: "owner" });

  /** A gate a test can open by hand. */
  function gate() {
    let reach!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(r => (reach = r));
    const held = new Promise<void>(r => (release = r));
    return { entered, held, reach, release };
  }
  const settle = () => new Promise(r => setTimeout(r, 50));

  it("is asked once per mutation, with the inner store, and never for a read", async () => {
    const inner = new InMemoryStore();
    const asked: unknown[] = [];
    const lock: LockProvider = { withLock: (store, step) => { asked.push(store); return inProcessLock.withLock(store, step); } };
    const g = govern(inner, { policies: [open], context, lock });
    const a = await g.addNode(makeNode());
    const b = await g.addNode(makeNode());
    await g.updateNode(a.nodeId, { confidenceWeight: 0.5 });
    const edge = await g.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    await g.getNode(a.nodeId);
    await g.listNodes();
    await g.searchNodes({});
    await g.getEdges(a.nodeId);
    await g.deleteEdge(edge.edgeId);
    await g.deleteNode(a.nodeId);
    expect(asked).toHaveLength(6);
    expect(asked.every(s => s === inner)).toBe(true);
  });

  /** Two handles over one store: does B's decision wait while A is between its decision and its write? */
  async function bWaitsForA(lockForB: LockProvider | undefined): Promise<boolean> {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(makeNode());
    const hold = gate();
    let bDecided = false;
    const holding: GovernancePolicy = { name: "holding", async beforeUpdate() { hold.reach(); await hold.held; } };
    const noting: GovernancePolicy = { name: "noting", beforeUpdate() { bDecided = true; } };
    const a = govern(inner, { policies: [holding], context });
    const b = govern(inner, { policies: [noting], context, ...(lockForB && { lock: lockForB }) });
    const first = a.updateNode(fact.nodeId, { confidenceWeight: 0.9 });
    await hold.entered;
    const second = b.updateNode(fact.nodeId, { confidenceWeight: 0.8 });
    await settle();
    const waited = !bDecided;
    hold.release();
    await Promise.all([first, second]);
    return waited;
  }

  it("left out, it is inProcessLock: a handle given inProcessLock queues with one given nothing", async () => {
    expect(await bWaitsForA(undefined)).toBe(true);
    expect(await bWaitsForA(inProcessLock)).toBe(true);
  });

  it("given one, it replaces the default: a lock that excludes nothing lets B decide inside A's window", async () => {
    expect(await bWaitsForA({ withLock: (_store, step) => step() })).toBe(false);
  });

  it("a refused mutation goes through the provider and does not keep the lock", async () => {
    const inner = new InMemoryStore();
    let held = 0;
    const lock: LockProvider = { async withLock(store, step) { held++; try { return await inProcessLock.withLock(store, step); } finally { held--; } } };
    const refuse: GovernancePolicy = { name: "refuse", beforeWrite(node) { if (node.content.text === "no") throw new PolicyDenied("refuse", "no"); return node; } };
    const g = govern(inner, { policies: [refuse], context, lock });
    await expect(g.addNode(makeNode({ content: { text: "no" } }))).rejects.toThrow(PolicyDenied);
    expect(held).toBe(0);
    await expect(g.addNode(makeNode({ content: { text: "yes" } }))).resolves.toBeDefined();
  });
});

/**
 * GovernedOperations (2026-11-17): the hook team memory's promote and
 * withdraw moved behind when they left this package. A toy operation, `stamp`,
 * labels a fact through the kit; the handle must still decide who sees what,
 * refuse and audit, and keep its own methods its own.
 */
describe("GovernedOperations: methods a host adds run through the handle's queue, policies and audit", () => {
  interface StampPolicy extends GovernancePolicy {
    beforeStamp?(node: MemoryNode, ctx: PolicyContext): void;
  }
  const stamping: GovernedOperations = {
    name: "stamping",
    purposes: ["stamp"],
    methods: (kit) => ({
      async stamp(id: string, label: string): Promise<MemoryNode> {
        const authorised = kit.authorise("stamp");
        return kit.serialise(async () => {
          kit.assertAuditUsable();
          const ctx = authorised();
          const { node } = await kit.visibleOrNotFound(id, ctx);
          const patch = { contextualMetadata: { ...node.contextualMetadata, stamp: label } };
          await kit.guarded(ctx, [id], async () => {
            await kit.updatePolicies(node, patch, ctx);
            for (const p of kit.policies as readonly StampPolicy[]) p.beforeStamp?.(node, ctx);
          });
          return kit.commit(ctx, () => kit.inner.updateNode(id, patch), (n) => ({ ids: [n.nodeId], reason: label }));
        });
      },
    }),
  };
  const hidesSecret: StampPolicy = {
    name: "hides-secret",
    beforeRead: (node, ctx) => (node.contextualMetadata["secret"] === true && ctx.actor !== "owner" ? null : node),
    beforeStamp: (_node, ctx) => {
      if (ctx.actor === "intern") throw new PolicyDenied("hides-secret", "interns do not stamp");
    },
  };
  const handle = (inner: InMemoryStore, actor: string, audit: MemoryAudit, operations: readonly GovernedOperations[] = [stamping]) =>
    govern(inner, { policies: [hidesSecret], context: () => ({ actor }), audit, operations }) as ReturnType<typeof govern> & { stamp?: (id: string, label: string) => Promise<MemoryNode> };

  it("writes through commit, audited under the operation's own purpose", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(makeNode({ content: { text: "open fact" } }));
    const audit = new MemoryAudit();
    const stamped = await handle(inner, "owner", audit).stamp!(fact.nodeId, "checked");
    expect(stamped.contextualMetadata["stamp"]).toBe("checked");
    expect((await inner.getNode(fact.nodeId))!.contextualMetadata["stamp"]).toBe("checked");
    expect(audit.events.filter((e) => e.purpose === "stamp")).toMatchObject([{ outcome: "allowed", actor: "owner", nodeIds: [fact.nodeId], reason: "checked" }]);
  });

  it("a fact the actor cannot see is not found, and a policy's refusal is audited, with nothing written", async () => {
    const inner = new InMemoryStore();
    const secret = await inner.addNode(makeNode({ content: { text: "secret" }, contextualMetadata: { secret: true } }));
    const open = await inner.addNode(makeNode({ content: { text: "open" } }));
    const audit = new MemoryAudit();
    await expect(handle(inner, "guest", audit).stamp!(secret.nodeId, "x")).rejects.toThrow(`Memory node not found: ${secret.nodeId}`);
    await expect(handle(inner, "intern", audit).stamp!(open.nodeId, "x")).rejects.toThrow(PolicyDenied);
    expect(audit.events.map((e) => [e.purpose, e.outcome, e.actor])).toEqual([["stamp", "denied", "guest"], ["stamp", "denied", "intern"]]);
    expect((await inner.getNode(secret.nodeId))!.contextualMetadata["stamp"]).toBeUndefined();
    expect((await inner.getNode(open.nodeId))!.contextualMetadata["stamp"]).toBeUndefined();
  });

  it("refuses a core purpose, a purpose claimed twice, a method the handle has, and an undeclared purpose", async () => {
    const inner = new InMemoryStore();
    const audit = new MemoryAudit();
    const named = (o: Partial<GovernedOperations>): GovernedOperations => ({ name: "o", purposes: ["o"], methods: () => ({}), ...o });
    expect(() => handle(inner, "owner", audit, [named({ purposes: ["erase"] })])).toThrow(/core purpose "erase"/);
    expect(() => handle(inner, "owner", audit, [named({ purposes: [] })])).toThrow(/must declare their purposes/);
    expect(() => handle(inner, "owner", audit, [named({ name: "a" }), named({ name: "b" })])).toThrow(/claimed by both a and b/);
    expect(() => handle(inner, "owner", audit, [named({ methods: () => ({ deleteNode: async () => undefined }) })])).toThrow(/cannot add deleteNode/);
    expect(() => handle(inner, "owner", audit, [stamping, named({ methods: () => ({ stamp: async () => undefined }) })])).toThrow(/cannot add stamp/);
    const sneaky = named({ methods: (kit) => ({ sneak: async () => kit.authorise("erase") }) });
    const g = handle(inner, "owner", audit, [sneaky]) as unknown as { sneak: () => Promise<unknown> };
    await expect(g.sneak()).rejects.toThrow(/did not declare the purpose "erase"/);
  });

  it("left out, the handle has exactly its own methods; an export view never carries them", () => {
    const inner = new InMemoryStore();
    const plain = Object.keys(govern(inner, { policies: [], context: () => ({ actor: "owner" }) })).sort();
    const extended = Object.keys(handle(inner, "owner", new MemoryAudit())).sort();
    expect(extended).toEqual([...plain, "stamp"].sort());
    const view = exportView(inner, { policies: [], context: () => ({ actor: "owner" }), operations: [stamping] });
    expect(Object.keys(view).sort()).not.toContain("stamp");
  });
});

/**
 * registerTools (2026-11-17): a host's own MCP tools, added after the core's.
 * Team memory's MCP tools moved behind it.
 */
describe("registerTools: a host's own MCP tools, after the core's", () => {
  async function toolsOf(deps: GovernanceDeps): Promise<{ names: string[]; call: (name: string, args: Record<string, unknown>) => Promise<unknown>; close: () => Promise<void> }> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { server } = await createGovernanceMcpServer(deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
    return { names: (await client.listTools()).tools.map((t) => t.name), call: (name, args) => client.callTool({ name, arguments: args }), close: () => client.close() };
  }

  it("adds the host's tool beside the core's; without it, exactly the core's", async () => {
    const store = new InMemoryStore();
    const fact = await store.addNode(makeNode({ content: { text: "a fact" } }));
    const plain = await toolsOf({ store });
    expect(plain.names.sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    await plain.close();

    const added = await toolsOf({
      store,
      registerTools: ({ server, z, json, deps }) => {
        server.tool("count_text", "Length of a fact's text.", { id: z.string() }, async (a) => json({ length: (await deps.store.getNode(a.id))!.content.text.length }));
      },
    });
    expect(added.names.sort()).toEqual([...Object.keys(TOOL_ANNOTATIONS), "count_text"].sort());
    expect(await added.call("count_text", { id: fact.nodeId })).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ length: 6 }, null, 2) }] });
    await added.close();
  });

  it("a host's tool cannot take a core tool's name", async () => {
    const registerTools: GovernanceDeps["registerTools"] = ({ server, json }) => {
      server.tool("recall", "Not the core's recall.", {}, async () => json([]));
    };
    await expect(createGovernanceMcpServer({ store: new InMemoryStore(), registerTools })).rejects.toThrow(/Tool recall is already registered/);
  });
});
