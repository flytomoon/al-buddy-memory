/**
 * The teamMemory sample (docs/policies/scopes.md) on every store — SQLite,
 * Postgres (PGlite here) and in-memory: a fact's `scope` label decides who
 * reads it, an unlabelled write is the writer's own, and neither `scope` nor
 * `author` ever changes. boundary-parity.test.ts holds the three stores to the
 * same answers; this file holds each to the rules.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import { PostgresMemoryStore } from "../postgres-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { govern } from "./governed-store.js";
import type { PolicyContext } from "./policy.js";
import { teamMemory, teamMemoryAttributes } from "./samples.js";

let pg: PGlite;
let tenant = 0;
beforeAll(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
});
afterAll(async () => {
  await pg.close();
});

const makers: [string, () => Promise<MemoryStore>][] = [
  ["sqlite", async () => new SqliteMemoryStore(":memory:")],
  [
    "postgres",
    async () => {
      const store = new PostgresMemoryStore({ tenantId: `team-memory-${++tenant}`, client: pg });
      await store.initialize();
      return store;
    },
  ],
  ["in-memory", async () => new InMemoryStore()],
];

const AT = "2026-01-05T00:00:00.000Z";
const seed = (id: string, text: string, labels: Record<string, unknown>): MemoryNode => ({
  ...makeNode({ content: { text }, contextualMetadata: labels }),
  nodeId: id,
  temporalAnchors: [{ event: "created", timestamp: AT }],
  validFrom: AT,
  validTo: null,
});
const fresh = (text: string, labels: Record<string, unknown> = {}) => makeNode({ content: { text }, contextualMetadata: labels });

const SEEDS: MemoryNode[] = [
  seed("ana-own", "Ana's own note", { scope: "user:ana", author: "ana" }),
  seed("ben-own", "Ben's own note", { scope: "user:ben", author: "ben" }),
  seed("blue", "Blue team runbook", { scope: "team:blue", author: "ana" }),
  seed("red", "Red team runbook", { scope: "team:red", author: "ben" }),
  seed("org", "Company holiday calendar", { scope: "org", author: "ben" }),
  seed("red-green", "Red and green shared plan", { scope: ["team:red", "team:green"], author: "ben" }),
  seed("unscoped", "A fact from before the policy", {}),
  seed("odd", "A scope that is not a string", { scope: 42 }),
];

/** A governed handle for one actor, with the attributes teamMemory reads. */
function as(inner: MemoryStore, actor: string, teams?: string[], opts: { raw?: PolicyContext["attributes"]; importers?: string[] } = {}) {
  const attributes = opts.raw ?? teamMemoryAttributes(actor, teams === undefined ? {} : { teams });
  return govern(inner, { policies: [teamMemory({ importers: opts.importers ?? [] })], context: () => ({ actor, attributes }) });
}

const ids = (nodes: MemoryNode[]) => nodes.map((n) => n.nodeId).sort();

describe.each(makers)("teamMemory (%s)", (_name, make) => {
  async function seeded(): Promise<MemoryStore> {
    const inner = await make();
    for (const n of SEEDS) await inner.restoreNode(n);
    return inner;
  }

  it("reads: the actor's own scope, their teams' and org — nothing else, on every read path", async () => {
    const inner = await seeded();
    const visible = async (store: MemoryStore) => {
      const listed = ids(await store.listNodes());
      expect(ids(await store.searchNodes({}))).toEqual(listed);
      for (const n of SEEDS) expect((await store.getNode(n.nodeId))?.nodeId ?? null).toBe(listed.includes(n.nodeId) ? n.nodeId : null);
      return listed;
    };
    expect(await visible(as(inner, "ana", ["blue"]))).toEqual(["ana-own", "blue", "org"]);
    expect(await visible(as(inner, "ben", ["red"]))).toEqual(["ben-own", "org", "red", "red-green"]);
    expect(await visible(as(inner, "cy", ["green", "blue"]))).toEqual(["blue", "org", "red-green"]);
    // No teams at all: org only (and their own, of which they have none).
    expect(await visible(as(inner, "newhire"))).toEqual(["org"]);
  });

  it("a directory group named like a scope is a team, and cannot widen a read", async () => {
    const inner = await seeded();
    expect(ids(await as(inner, "eve", ["org", "user:ana", "team:blue"]).listNodes())).toEqual(["org"]);
  });

  it("a context without teamMemoryAttributes fails closed: unprefixed teams and a borrowed self show nothing extra", async () => {
    const inner = await seeded();
    // Teams as the directory sends them: no team: prefix, so no team fact matches.
    expect(ids(await as(inner, "ana", undefined, { raw: { teams: ["blue"] } }).listNodes())).toEqual(["org"]);
    // A context that hands ben ana's `self` passes the boundary; the per-fact check is against the actor.
    expect(ids(await as(inner, "ben", undefined, { raw: { self: "user:ana", teams: ["user:ana"] } }).listNodes())).toEqual(["org"]);
  });

  it("writes: an unlabelled fact is the writer's own, stamped with scope and author; nobody else sees it", async () => {
    const inner = await seeded();
    const ana = as(inner, "ana", ["blue"]);
    const written = await ana.addNode(fresh("Ana's standup moved to 9:30", { tags: ["standup"] }));
    expect(written.contextualMetadata).toEqual({ tags: ["standup"], scope: "user:ana", author: "ana" });
    expect((await inner.getNode(written.nodeId))?.contextualMetadata).toEqual({ tags: ["standup"], scope: "user:ana", author: "ana" });
    expect(await as(inner, "ben", ["blue"]).getNode(written.nodeId)).toBeUndefined();
    expect(ids(await ana.searchNodes({ query: "standup" }))).toEqual([written.nodeId]);
    // Half-labelled: the missing half is stamped.
    expect((await ana.addNode(fresh("explicit scope", { scope: ["user:ana"] }))).contextualMetadata).toEqual({ scope: ["user:ana"], author: "ana" });
    expect((await ana.addNode(fresh("explicit author", { author: "ana" }))).contextualMetadata).toEqual({ author: "ana", scope: "user:ana" });
    expect((await ana.addNode(fresh("empty scope", { scope: [] }))).contextualMetadata).toEqual({ scope: "user:ana", author: "ana" });
  });

  it("writes naming another scope or another author are refused, and nothing is written", async () => {
    const inner = await seeded();
    const ana = as(inner, "ana", ["blue"]);
    const before = (await inner.listNodes()).length;
    for (const labels of [
      { scope: "team:blue" },
      { scope: "org" },
      { scope: "user:ben" },
      { scope: ["user:ana", "org"] },
      { scope: 42 },
      { scope: ["user:ana", 7] },
      { author: "ben" },
      { scope: "user:ana", author: "ben" },
      { author: 1 },
    ]) {
      await expect(ana.addNode(fresh("try", labels)), JSON.stringify(labels)).rejects.toThrow(/team-memory/);
    }
    expect((await inner.listNodes()).length).toBe(before);
  });

  it("scope and author never change, by edit, by dropping the label, or by restore; other changes and invalidation go through", async () => {
    const inner = await seeded();
    const ana = as(inner, "ana", ["blue"]);
    const mine = await ana.addNode(fresh("Ana's draft"));
    const cm = mine.contextualMetadata;
    for (const contextualMetadata of [
      { ...cm, scope: "org" },
      { ...cm, scope: ["user:ana", "team:blue"] },
      { ...cm, author: "ben" },
      { tags: ["x"] },
      { ...cm, author: undefined },
    ]) {
      await expect(ana.updateNode(mine.nodeId, { contextualMetadata }), JSON.stringify(contextualMetadata)).rejects.toThrow(/team-memory/);
    }
    expect((await inner.getNode(mine.nodeId))?.contextualMetadata).toEqual(cm);

    const tagged = await ana.updateNode(mine.nodeId, { contextualMetadata: { ...cm, tags: ["draft"] } });
    expect(tagged.contextualMetadata).toEqual({ ...cm, tags: ["draft"] });
    // A team member may work on a team fact; its scope and author stay.
    const ben = as(inner, "ben", ["red"]);
    await expect(ben.updateNode("red", { contextualMetadata: { scope: "org", author: "ben" } })).rejects.toThrow(/team-memory/);
    await ben.updateNode("red-green", { contextualMetadata: { scope: ["team:green", "team:red", "team:red"], author: "ben", tags: ["plan"] } });
    expect((await inner.getNode("red-green"))?.contextualMetadata["tags"]).toEqual(["plan"]);
    // Invalidation closes validTo and keeps both labels: never deleted.
    const closed = await ana.updateNode(mine.nodeId, { validTo: "2026-02-01T00:00:00.000Z" });
    expect(closed.validTo).toBe("2026-02-01T00:00:00.000Z");
    expect(closed.contextualMetadata).toMatchObject({ scope: "user:ana", author: "ana" });
  });

  it("import: verbatim only for importers; anyone else's is judged as a write, and a restore cannot move a fact", async () => {
    const inner = await seeded();
    const team = seed("imported-team", "Restored blue runbook", { scope: "team:blue", author: "ben" });
    await expect(as(inner, "ana", ["blue"]).restoreNode(team)).rejects.toThrow(/team-memory/);
    expect(await inner.getNode("imported-team")).toBeUndefined();
    // Ana's own facts restore, stamped like a write.
    await as(inner, "ana", ["blue"]).restoreNode(seed("imported-own", "Restored note", {}));
    expect((await inner.getNode("imported-own"))?.contextualMetadata).toEqual({ scope: "user:ana", author: "ana" });

    const admin = as(inner, "ops", undefined, { importers: ["ops"] });
    await admin.restoreNode(team);
    expect((await inner.getNode("imported-team"))?.contextualMetadata).toEqual({ scope: "team:blue", author: "ben" });
    // An importer restoring over a fact it can see still cannot change its scope (org is visible to ops).
    await expect(admin.restoreNode({ ...SEEDS.find((n) => n.nodeId === "org")!, contextualMetadata: { scope: "user:ops", author: "ben" } })).rejects.toThrow(/team-memory/);
    expect((await inner.getNode("org"))?.contextualMetadata).toEqual({ scope: "org", author: "ben" });
  });
});

describe("teamMemoryAttributes", () => {
  it("adds self, prefixes every team once, and passes the rest through", () => {
    expect(teamMemoryAttributes("ana", { teams: ["blue", "red", "blue", ""], roles: ["admin"], department: "ops" })).toEqual({
      teams: ["team:blue", "team:red"],
      roles: ["admin"],
      department: "ops",
      self: "user:ana",
    });
    expect(teamMemoryAttributes("ana", { teams: "blue" })).toEqual({ teams: ["team:blue"], self: "user:ana" });
    expect(teamMemoryAttributes("ana")).toEqual({ teams: [], self: "user:ana" });
    // Already prefixed is prefixed again, and a self from the claims is replaced.
    expect(teamMemoryAttributes("ana", { teams: ["team:blue", "org"], self: "user:ben" })).toEqual({ teams: ["team:team:blue", "team:org"], self: "user:ana" });
  });
});
