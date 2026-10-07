/**
 * The same facts, policies and questions give the same visible answers on every
 * store — SQLite (the default), Postgres (PGlite here) and in-memory — and
 * facts an actor cannot see change neither which facts they get, nor the
 * order, nor how many. The policy is the shipped example, docs/policies/boundaries.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import type { LabelFilter, MemoryNode, MemoryQueryOptions, MemoryStore } from "../types/memory.js";
import { govern } from "./governed-store.js";
import type { PolicyContext } from "./policy.js";
import { boundaries } from "../../docs/policies/boundaries.js";

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
  sqlite: async () => new SqliteMemoryStore(":memory:"),
  postgres: async () => {
    const store = new PostgresMemoryStore({ tenantId: `parity-${++tenant}`, client: pg });
    await store.initialize();
    return store;
  },
  "in-memory": async () => new InMemoryStore(),
};

type Seed = [id: string, text: string, labels: Record<string, unknown>, extra?: Partial<MemoryNode>];

/** Fixed ids and instants, so every store holds exactly the same facts. */
function fact([id, text, labels, extra]: Seed, day: number): MemoryNode {
  const at = new Date(Date.UTC(2026, 0, day)).toISOString();
  return {
    ...makeNode({ content: { text }, contextualMetadata: labels }),
    nodeId: id,
    temporalAnchors: [{ event: "created", timestamp: at }],
    validFrom: at,
    validTo: null,
    ...extra,
  };
}

const SEEDS: Seed[] = [
  ["f01", "Quarterly budget review for Acme", { team: "blue", client: "acme", tags: ["q3"] }],
  ["f02", "Acme roadmap draft", { team: "blue", client: "acme", rate: 120 }],
  ["f03", "Globex budget overrun", { team: "blue", client: "globex" }],
  ["f04", "Internal budget tooling notes", { team: "blue", client: "internal" }],
  ["f05", "Red team budget for Acme", { team: "red", client: "acme", tags: ["q3"] }],
  ["f06", "Company holiday calendar and budget freeze", { visibility: "company" }],
  ["f07", "Red roadmap for Initech", { team: "red", client: "initech", rate: 95 }],
  ["f08", "Blue Acme budget, low confidence", { team: "blue", client: "acme" }, { confidenceWeight: 0.4 }],
  ["f09", "Untagged budget note", {}],
  ["f10", "Shared roadmap with Acme across teams", { team: ["blue", "red"], client: "acme" }],
  ["f11", "Sealed budget for Acme", { team: "blue", client: "acme" }, { privacyClassification: "Sealed" }],
  ["f12", "Old budget archive for Acme", { team: "blue", client: "acme" }, { retentionTier: "Archived" }],
  ["f13", "Budget budget budget for Acme", { team: "blue", client: "acme" }],
  ["f14", "Acme budget", { team: "blue", client: "acme" }, { confidenceWeight: 0.9 }],
];

/** Facts no actor below may see, built to rank first if they ever could. */
const NOISE: Seed[] = Array.from({ length: 30 }, (_, i): Seed => [
  `n${String(i).padStart(2, "0")}`,
  ["budget", "Acme budget roadmap", "budget budget acme review", "roadmap q3 budget"][i % 4]!,
  [
    { team: "green", client: "acme", tags: ["q3"] },
    { team: "blue", client: "umbrella", tags: ["q3"] },
    { team: ["green", "purple"], client: ["acme"] },
    { visibility: "board", team: "blue" },
    { team: "red", client: "hooli" },
    {},
  ][i % 6]!,
]);

const ACTORS: Record<string, PolicyContext["attributes"]> = {
  ana: { teams: ["blue"], clients: ["acme", "internal"] },
  ben: { teams: "red", clients: ["acme", "initech", "internal"], roles: ["finance"] },
  cy: { teams: ["blue", "red"], clients: ["globex", "internal"] },
  guest: undefined,
};

const QUERIES: MemoryQueryOptions[] = [
  {},
  { limit: 3 },
  { limit: 1 },
  { query: "budget" },
  { query: "budget acme", limit: 2 },
  { query: "roadmap" },
  { query: "Acme review", limit: 4 },
  { tags: ["q3"] },
  { retentionTier: ["Archived"] },
  { privacyClassification: ["Sealed"] },
  { limit: 2, after: "f02" },
  { query: "budget", after: "f14" },
  { minConfidence: 0.5, limit: 5 },
  { query: "budget", labels: { label: "client", in: ["acme"] } },
];

async function seeded(name: string, seeds: Seed[]): Promise<MemoryStore> {
  const store = await makers[name]!();
  for (const [i, seed] of seeds.entries()) await store.restoreNode(fact(seed, i + 1));
  return store;
}

async function addNoise(store: MemoryStore): Promise<void> {
  // Newer than every visible fact, so recency would put them first too.
  for (const [i, seed] of NOISE.entries()) await store.restoreNode(fact(seed, 100 + i));
}

/** Everything one actor gets back for every question, in order. */
async function answers(inner: MemoryStore, actor: string): Promise<unknown> {
  const store = govern(inner, { policies: [boundaries], context: () => ({ actor, attributes: ACTORS[actor] }) });
  const out: Record<string, unknown> = {};
  for (const q of QUERIES) out[JSON.stringify(q)] = await store.searchNodes(q);
  for (const [id] of SEEDS) out[`get ${id}`] = (await store.getNode(id)) ?? null;
  out["list"] = (await store.listNodes()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  return out;
}

const ids = (nodes: unknown) => (nodes as MemoryNode[]).map((n) => n.nodeId);

describe("data boundaries give the same answers on SQLite and Postgres", () => {
  it("(a) identical visible results for every actor and question", async () => {
    const results: Record<string, Record<string, unknown>> = {};
    for (const name of Object.keys(makers)) {
      const store = await seeded(name, SEEDS);
      results[name] = {};
      for (const actor of Object.keys(ACTORS)) results[name]![actor] = await answers(store, actor);
    }
    expect(results["postgres"]).toEqual(results["sqlite"]);
    expect(results["in-memory"]).toEqual(results["sqlite"]);

    // Not vacuous: the boundary, the redaction and the defaults all did something.
    const ana = results["sqlite"]!["ana"] as Record<string, MemoryNode[]>;
    expect(ids(ana["{}"])).toEqual(expect.arrayContaining(["f01", "f02", "f04", "f06", "f10", "f13", "f14"]));
    expect(ids(ana["{}"]).some((id) => ["f03", "f05", "f07", "f09", "f11", "f12"].includes(id))).toBe(false);
    expect(ids(ana['{"query":"budget"}']).length).toBeGreaterThan(3);
    expect(ana["get f02"]).toMatchObject({ contextualMetadata: { team: "blue", client: "acme" } });
    expect((ana["get f02"] as unknown as MemoryNode).contextualMetadata).not.toHaveProperty("rate");
    const ben = results["sqlite"]!["ben"] as Record<string, MemoryNode[]>;
    expect((ben["get f07"] as unknown as MemoryNode).contextualMetadata).toHaveProperty("rate", 95);
    expect(ids(ben["{}"])).toEqual(expect.arrayContaining(["f05", "f06", "f07", "f10"]));
    const guest = results["sqlite"]!["guest"] as Record<string, MemoryNode[]>;
    expect(ids(guest["{}"])).toEqual(["f06"]);
  });

  it("(a) the stores' own label filter admits the same facts", async () => {
    const filters: LabelFilter[] = [
      { label: "team", in: ["blue"] },
      { any: [{ label: "visibility", in: ["company"] }, { all: [{ label: "team", in: ["red"] }, { label: "client", in: ["acme", "initech"] }] }] },
    ];
    const seen: Record<string, unknown[]> = {};
    for (const name of Object.keys(makers)) {
      const store = await seeded(name, SEEDS);
      seen[name] = [];
      for (const labels of filters) {
        seen[name]!.push(ids(await store.searchNodes({ labels })));
        seen[name]!.push(ids(await store.searchNodes({ labels, limit: 2 })));
        // Keyword order is each engine's own relevance; the set is what must agree.
        seen[name]!.push(ids(await store.searchNodes({ labels, query: "budget roadmap" })).sort());
      }
    }
    expect(seen["postgres"]).toEqual(seen["sqlite"]);
    expect(seen["in-memory"]).toEqual(seen["sqlite"]);
  });

  it.each(Object.keys(makers))("(b) hidden facts change neither which facts come back, nor their order, nor how many (%s)", async (name) => {
    const store = await seeded(name, SEEDS);
    const before: Record<string, unknown> = {};
    for (const actor of Object.keys(ACTORS)) before[actor] = await answers(store, actor);
    await addNoise(store);
    expect((await store.listNodes()).length).toBe(SEEDS.length + NOISE.length);
    for (const actor of Object.keys(ACTORS)) expect(await answers(store, actor)).toEqual(before[actor]);
  });
});
