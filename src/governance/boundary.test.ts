/**
 * Data boundaries: a policy's read rule declared as a filter over fact labels
 * (`contextualMetadata`) and the asking actor's attributes, applied by the
 * store INSIDE the query — before any limit — and by every governed read.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { matchesFilter } from "../query-filter.js";
import type { LabelFilter, MemoryNode, MemoryQueryOptions, MemoryStore } from "../types/memory.js";
import { exportView, govern } from "./governed-store.js";
import type { GovernancePolicy, PolicyContext } from "./policy.js";

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
  ["in-memory", async () => new InMemoryStore()],
  ["sqlite", async () => new SqliteMemoryStore(":memory:")],
  [
    "postgres",
    async () => {
      const store = new PostgresMemoryStore({ tenantId: `boundary-${++tenant}`, client: pg, indexedDimensions: 3 });
      await store.initialize();
      return store;
    },
  ],
];

const add = (store: MemoryStore, text: string, labels: Record<string, unknown> = {}, extra: Parameters<typeof makeNode>[0] = {}) =>
  store.addNode(makeNode({ content: { text }, contextualMetadata: labels, ...extra }));
const texts = (nodes: MemoryNode[]) => nodes.map((n) => n.content.text);
const sorted = (nodes: MemoryNode[]) => texts(nodes).sort();

const teamOf: GovernancePolicy = { name: "teams", readBoundary: { label: "team", in: { actor: "teams" } } };

describe.each(stores)("a label filter inside the store's query (%s)", (_label, make) => {
  it("applies before the limit, with and without a keyword query", async () => {
    const store = await make();
    for (let i = 0; i < 6; i++) await add(store, `budget review ${i} for red`, { team: "red" });
    await add(store, "budget blue first", { team: "blue" }, { confidenceWeight: 0.4 });
    await add(store, "budget blue second", { team: "blue" }, { confidenceWeight: 0.3 });
    const labels: LabelFilter = { label: "team", in: ["blue"] };
    expect(sorted(await store.searchNodes({ labels, limit: 2 }))).toEqual(["budget blue first", "budget blue second"]);
    expect(sorted(await store.searchNodes({ labels, query: "budget", limit: 2 }))).toEqual(["budget blue first", "budget blue second"]);
    expect(texts(await store.searchNodes({ labels, limit: 1 }))).toEqual(["budget blue first"]);
  });

  it("matches a label that is the value or an array holding it; a missing or other-typed label matches nothing", async () => {
    const store = await make();
    await add(store, "string", { team: "blue" });
    await add(store, "array", { team: ["red", "blue"] });
    await add(store, "other array", { team: ["blue-ish", "red"] });
    await add(store, "number", { team: 7 });
    await add(store, "object", { team: { blue: true } });
    await add(store, "nested array", { team: [["blue"]] });
    await add(store, "missing", {});
    await add(store, "seven as text", { team: "7" });
    expect(sorted(await store.searchNodes({ labels: { label: "team", in: ["blue"] } }))).toEqual(["array", "string"]);
    expect(sorted(await store.searchNodes({ labels: { label: "team", in: ["7"] } }))).toEqual(["seven as text"]);
    expect(await store.searchNodes({ labels: { label: "team", in: [] } })).toEqual([]);
    expect(await store.searchNodes({ labels: { any: [] } })).toEqual([]);
    expect(await store.searchNodes({ labels: { all: [] } })).toHaveLength(8);
  });

  it("combines with AND and OR, and keeps every other filter and default", async () => {
    const store = await make();
    await add(store, "blue acme", { team: "blue", client: "acme", tags: ["q3"] });
    await add(store, "blue globex", { team: "blue", client: "globex" });
    await add(store, "red acme", { team: "red", client: "acme" });
    await add(store, "everyone", { visibility: "company" });
    await add(store, "sealed blue acme", { team: "blue", client: "acme" }, { privacyClassification: "Sealed" });
    const labels: LabelFilter = {
      any: [{ label: "visibility", in: ["company"] }, { all: [{ label: "team", in: ["blue"] }, { label: "client", in: ["acme"] }] }],
    };
    expect(sorted(await store.searchNodes({ labels }))).toEqual(["blue acme", "everyone"]);
    expect(sorted(await store.searchNodes({ labels, tags: ["q3"] }))).toEqual(["blue acme"]);
    expect(sorted(await store.searchNodes({ labels, query: "acme" }))).toEqual(["blue acme"]);
    expect(sorted(await store.searchNodes({ labels, privacyClassification: ["Sealed"] }))).toEqual(["sealed blue acme"]);
  });

  it("is a parameter, never SQL: labels and values that look like SQL or JSON paths are just strings", async () => {
    const store = await make();
    const key = `te'am"].$x; DROP TABLE memory_nodes --`;
    await add(store, "odd", { [key]: "v'1\"" });
    await add(store, "plain", { team: "blue" });
    expect(texts(await store.searchNodes({ labels: { label: key, in: ["v'1\""] } }))).toEqual(["odd"]);
    expect(await store.searchNodes({ labels: { label: "team", in: ["' OR 1=1 --"] } })).toEqual([]);
    expect(await store.listNodes()).toHaveLength(2);
  });

  it("agrees with matchesFilter, the predicate the vector path uses", async () => {
    const store = await make();
    await add(store, "a", { team: "blue", client: "acme" });
    await add(store, "b", { team: ["blue", "red"] });
    await add(store, "c", { client: "acme" });
    await add(store, "d", {});
    const filters: LabelFilter[] = [
      { label: "team", in: ["blue"] },
      { any: [{ label: "team", in: ["red"] }, { label: "client", in: ["acme"] }] },
      { all: [{ label: "team", in: ["blue"] }, { label: "client", in: ["acme"] }] },
    ];
    const all = await store.listNodes();
    for (const labels of filters) {
      expect(sorted(await store.searchNodes({ labels }))).toEqual(sorted(all.filter((n) => matchesFilter(n, { labels }))));
    }
  });
});

describe.each(stores)("a declared read boundary on a governed handle (%s)", (_label, make) => {
  const as = (inner: MemoryStore, policies: GovernancePolicy[], ctx: Partial<PolicyContext> & { actor: string }) =>
    govern(inner, { policies, context: () => ctx });

  it("hides facts outside it on every read, and they fail like missing facts", async () => {
    const inner = await make();
    const mine = await add(inner, "blue plan", { team: "blue" });
    const theirs = await add(inner, "red plan", { team: "red" });
    await inner.addEdge({ sourceNodeId: mine.nodeId, targetNodeId: theirs.nodeId, relationshipType: "Conceptual", strength: 1, provenance: "UserAsserted" });
    await inner.setEmbedding({ nodeId: theirs.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] });
    const store = as(inner, [teamOf], { actor: "ana", attributes: { teams: ["blue"] } });
    expect(texts(await store.searchNodes({}))).toEqual(["blue plan"]);
    expect(texts(await store.searchNodes({ query: "plan" }))).toEqual(["blue plan"]);
    expect(texts(await store.listNodes())).toEqual(["blue plan"]);
    expect(await store.getNode(theirs.nodeId)).toBeUndefined();
    expect(await store.getEdges(mine.nodeId)).toEqual([]);
    expect(await store.listEmbeddings("m")).toEqual([]);
    await expect(store.updateNode(theirs.nodeId, { confidenceWeight: 0.5 })).rejects.toThrow(`Memory node not found: ${theirs.nodeId}`);
    const exported = exportView(inner, { policies: [teamOf], context: () => ({ actor: "ana", attributes: { teams: ["blue"] } }) });
    expect(texts(await exported.listNodes())).toEqual(["blue plan"]);
  });

  it("fails closed: an actor without the attribute sees nothing the boundary guards", async () => {
    const inner = await make();
    await add(inner, "blue plan", { team: "blue" });
    await add(inner, "unlabelled", {});
    expect(await as(inner, [teamOf], { actor: "nobody" }).searchNodes({})).toEqual([]);
    expect(await as(inner, [teamOf], { actor: "nobody", attributes: { teams: [] } }).listNodes()).toEqual([]);
  });

  it("takes an attribute with one value or several, and equality as well as membership", async () => {
    const inner = await make();
    await add(inner, "acme", { client: "acme" });
    await add(inner, "globex", { client: "globex" });
    const byClient: GovernancePolicy = { name: "client", readBoundary: { label: "client", equals: { actor: "client" } } };
    expect(texts(await as(inner, [byClient], { actor: "a", attributes: { client: "acme" } }).searchNodes({}))).toEqual(["acme"]);
    expect(sorted(await as(inner, [byClient], { actor: "a", attributes: { client: ["acme", "globex"] } }).searchNodes({}))).toEqual(["acme", "globex"]);
    const literal: GovernancePolicy = { name: "literal", readBoundary: { label: "client", in: ["globex"] } };
    expect(texts(await as(inner, [literal], { actor: "a" }).searchNodes({}))).toEqual(["globex"]);
  });

  it("lets the per-fact beforeRead run afterwards and have the final word", async () => {
    const inner = await make();
    await add(inner, "blue plan", { team: "blue" });
    await add(inner, "blue salary", { team: "blue", salary: true });
    await add(inner, "blue rate 90", { team: "blue", rate: 90 });
    await add(inner, "red plan", { team: "red" });
    const policy: GovernancePolicy = {
      ...teamOf,
      beforeRead(node) {
        if (node.contextualMetadata["salary"]) return null;
        const { rate: _r, ...rest } = node.contextualMetadata;
        return { ...node, contextualMetadata: rest };
      },
    };
    const seen = await as(inner, [policy], { actor: "ana", attributes: { teams: ["blue"] } }).searchNodes({});
    expect(sorted(seen)).toEqual(["blue plan", "blue rate 90"]);
    expect(seen.every((n) => !("rate" in n.contextualMetadata))).toBe(true);
  });

  it("ANDs every policy's boundary, and a caller's own label filter can narrow it but never widen it", async () => {
    const inner = await make();
    await add(inner, "blue acme", { team: "blue", client: "acme" });
    await add(inner, "blue globex", { team: "blue", client: "globex" });
    await add(inner, "red acme", { team: "red", client: "acme" });
    const clientOf: GovernancePolicy = { name: "clients", readBoundary: { label: "client", in: { actor: "clients" } } };
    const store = as(inner, [teamOf, clientOf], { actor: "ana", attributes: { teams: ["blue"], clients: ["acme", "globex"] } });
    expect(sorted(await store.searchNodes({}))).toEqual(["blue acme", "blue globex"]);
    expect(texts(await store.searchNodes({ labels: { label: "client", in: ["acme"] } }))).toEqual(["blue acme"]);
    expect(await store.searchNodes({ labels: { label: "team", in: ["red"] } })).toEqual([]);
    expect(sorted(await store.searchNodes({ labels: { any: [{ label: "team", in: ["red"] }, { all: [] }] } }))).toEqual(["blue acme", "blue globex"]);
  });
});

describe("how a boundary reaches the store", () => {
  /** A store that records every search it is asked for. */
  function spied(inner: MemoryStore): { store: MemoryStore; calls: MemoryQueryOptions[] } {
    const calls: MemoryQueryOptions[] = [];
    const store = Object.create(inner) as MemoryStore;
    store.searchNodes = async (options) => {
      calls.push(options);
      return inner.searchNodes(options);
    };
    return { store, calls };
  }

  it("fills a page in one read: the facts outside it never reach the governed layer", async () => {
    const inner = new InMemoryStore();
    for (let i = 0; i < 50; i++) await add(inner, `red ${i}`, { team: "red" });
    await add(inner, "blue one", { team: "blue" }, { confidenceWeight: 0.2 });
    await add(inner, "blue two", { team: "blue" }, { confidenceWeight: 0.1 });
    const { store, calls } = spied(inner);
    const governed = govern(store, { policies: [teamOf], context: () => ({ actor: "ana", attributes: { teams: ["blue"] } }) });
    expect(texts(await governed.searchNodes({ limit: 2 }))).toEqual(["blue one", "blue two"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.labels).toEqual({ label: "team", in: ["blue"] });
  });

  it("is not sent at all when no policy declares one: today's behaviour", async () => {
    const inner = new InMemoryStore();
    await add(inner, "anything");
    const { store, calls } = spied(inner);
    const plain: GovernancePolicy = { name: "plain", beforeRead: (n) => n };
    await govern(store, { policies: [plain], context: () => ({ actor: "a" }) }).searchNodes({ query: "anything" });
    await govern(store, { policies: [plain], context: () => ({ actor: "a" }) }).searchNodes({ limit: 1 });
    expect(calls.every((c) => !("labels" in c))).toBe(true);
  });

  it("refuses a malformed declaration when the handle is made, not on the first read", () => {
    const bad = (readBoundary: unknown) => () => govern(new InMemoryStore(), { policies: [{ name: "bad", readBoundary } as GovernancePolicy], context: () => ({ actor: "a" }) });
    expect(bad({ label: "", in: [] })).toThrow(/bad/);
    expect(bad({ label: "team" })).toThrow(/bad/);
    expect(bad({ label: "team", in: [1] })).toThrow(/bad/);
    expect(bad({ label: "team", in: { actor: "" } })).toThrow(/bad/);
    expect(bad({ label: "team", like: "b%" })).toThrow(/bad/);
    expect(bad({ not: { label: "team", in: [] } })).toThrow(/bad/);
    expect(bad({ any: [{ label: "team", equals: 3 }] })).toThrow(/bad/);
  });
});

describe("Postgres: the boundary applies before the vector search's LIMIT", () => {
  it("returns the nearest fact inside the boundary even when nearer ones are outside it", async () => {
    const store = (await stores[2]![1]()) as PostgresMemoryStore;
    const red = await add(store, "red", { team: "red" });
    const blue = await add(store, "blue", { team: "blue" });
    await store.setEmbedding({ nodeId: red.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [1, 0, 0] });
    await store.setEmbedding({ nodeId: blue.nodeId, model: "m", modelVersion: "1", dimensions: 3, metric: "cosine", vector: [0, 1, 0] });
    const hits = await store.searchSimilar("m", "1", [1, 0, 0], { limit: 1, labels: { label: "team", in: ["blue"] } });
    expect(hits.map((h) => h.node.nodeId)).toEqual([blue.nodeId]);
  });
});

describe.each(stores)("a keyword search for a word a policy redacted (%s)", (_label, make) => {
  const redactOrion: GovernancePolicy = {
    name: "redact-orion",
    beforeRead: (node, ctx) => (ctx.actor === "agent" ? { ...node, content: { ...node.content, text: node.content.text.replace(/orion/gi, "[redacted]") } } : node),
  };

  it("does not find the fact by that word, so it does not reveal the fact exists", async () => {
    const inner = await make();
    await add(inner, "Project Orion launches in May");
    await add(inner, "Orion budget approved");
    const agent = govern(inner, { policies: [redactOrion], context: () => ({ actor: "agent" }) });
    const owner = govern(inner, { policies: [redactOrion], context: () => ({ actor: "owner" }) });
    expect(await agent.searchNodes({ query: "orion" })).toEqual([]);
    expect(await agent.searchNodes({ query: "Orion", limit: 1 })).toEqual([]);
    expect(await owner.searchNodes({ query: "orion" })).toHaveLength(2);
    // The words still visible find it, redacted.
    expect(texts(await agent.searchNodes({ query: "orion launches" }))).toEqual(["Project [redacted] launches in May"]);
  });

  it("does not let a fact redacted out of the match move the order of the others", async () => {
    const inner = await make();
    // Word rarity is counted over the visible matches; one more of them would flip these two.
    await add(inner, "alpha one two");
    await add(inner, "beta four");
    await add(inner, "beta five");
    const hide: GovernancePolicy = {
      name: "hide-text",
      beforeRead: (node) => (node.contextualMetadata["secret"] ? { ...node, content: { ...node.content, text: "[redacted]" } } : node),
    };
    const store = govern(inner, { policies: [hide], context: () => ({ actor: "agent" }) });
    const before = texts(await store.searchNodes({ query: "alpha beta" }));
    expect(before[0]).toBe("alpha one two");
    await add(inner, "beta secret", { secret: true });
    expect(texts(await store.searchNodes({ query: "alpha beta" }))).toEqual(before);
  });
});
