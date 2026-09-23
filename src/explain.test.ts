/**
 * "Why do you believe that?" — one call that answers with the fact, who said
 * it, when it was true and what replaced it, and for a conclusion the exact
 * words it rests on and whether they still hold.
 */
import { describe, expect, it } from "vitest";

import { consolidate } from "./consolidation.js";
import { explainFact } from "./explain.js";
import { InMemoryStore } from "./in-memory-store.js";
import { governanceTools, serverStore } from "./mcp/governance-server.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

const since = "2000-01-01T00:00:00.000Z";

describe.each([
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
] as [string, () => MemoryStore][])("explainFact (%s)", (_label, make) => {
  it("a stated fact: who said it, since when, current, and its history", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Lives in Tokyo" }, contextualMetadata: { origin: { app: "desk" } } }));
    await store.updateNode(a.nodeId, { confidenceWeight: 0.9 });
    const e = (await explainFact(store, a.nodeId))!;
    expect(e.fact).toMatchObject({ id: a.nodeId, text: "Lives in Tokyo", provenance: "UserInput", origin: { app: "desk" } });
    expect(e.validity).toMatchObject({ validFrom: a.validFrom, validTo: null, current: true, supersededBy: null, reason: null, retraction: null });
    expect(e.derived).toBeNull();
    expect(e.history).toMatchObject({ versions: 1 });
  });

  it("a retired fact: when it stopped, why, and what replaced it", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Lives in Tokyo" } }));
    const b = await store.addNode(makeNode({ content: { text: "Lives in Berlin" } }));
    await store.updateNode(a.nodeId, { validTo: "2026-09-01T00:00:00.000Z", contextualMetadata: { supersededBy: b.nodeId, invalidatedBecause: "moved" } });
    const e = (await explainFact(store, a.nodeId, { now: () => new Date("2026-09-22T00:00:00.000Z") }))!;
    expect(e.validity).toMatchObject({ validTo: "2026-09-01T00:00:00.000Z", current: false, supersededBy: b.nodeId, reason: "moved" });
  });

  it("a conclusion: the words it rests on, each checked, and what withdrew it", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "I moved to Berlin in May." } }));
    const r = await consolidate(store, { since, model: "m", propose: async () => [{ text: "Lives in Berlin", sourceNodeIds: [a.nodeId], evidence: [{ nodeId: a.nodeId, quote: "moved to Berlin" }] }] });
    const id = r.derivedNodeIds[0]!;
    let e = (await explainFact(store, id))!;
    expect(e.fact.provenance).toBe("AIInferred");
    expect(e.derived).toMatchObject({ derivedFrom: [a.nodeId], model: "m" });
    expect(e.derived!.evidence).toEqual([{ nodeId: a.nodeId, quote: "moved to Berlin", source: "available", holds: true }]);

    await store.updateNode(a.nodeId, { validTo: "2026-09-10T00:00:00.000Z" });
    e = (await explainFact(store, id))!;
    expect(e.validity.retraction).toMatchObject({ by: "invalidation" });
  });

  it("an unknown id is undefined", async () => {
    expect(await explainFact(make(), "nope")).toBeUndefined();
  });

  it("governed: a source the reader may not see is named as withheld, never shown", async () => {
    const inner = make();
    const secret = await inner.addNode(makeNode({ privacyClassification: "Sensitive", content: { text: "Therapist is Dr Lee" } }));
    const d = await inner.addNode(makeNode({ provenance: "AIInferred", content: { text: "Has a weekly appointment" }, contextualMetadata: { derivedFrom: [secret.nodeId], consolidatedAt: since, evidence: [{ nodeId: secret.nodeId, quote: "Dr Lee" }] } }));
    const e = (await explainFact(serverStore(inner), d.nodeId))!;
    expect(e.derived!.evidence).toEqual([{ nodeId: secret.nodeId, quote: null, source: "withheld", holds: null }]);
    expect(JSON.stringify(e)).not.toContain("Dr Lee");
    // And the hidden fact itself cannot be explained at all.
    expect(await explainFact(serverStore(inner), secret.nodeId)).toBeUndefined();
  });

  it("the MCP explain tool answers the same, and refuses an unknown id in words", async () => {
    const inner = make();
    const tools = governanceTools({ store: serverStore(inner) });
    const saved = await tools.remember({ text: "Prefers the window seat" });
    const e = await tools.explain({ id: saved.id });
    expect(e.fact.text).toBe("Prefers the window seat");
    await expect(tools.explain({ id: "nope" })).rejects.toThrow(/no fact nope/);
  });
});
