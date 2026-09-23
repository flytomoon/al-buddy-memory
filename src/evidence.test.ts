/**
 * Every derived fact carries the exact words it rests on, and they are checked:
 * on the way in (consolidate refuses a conclusion its sources do not support)
 * and any time after (verifyDerived retracts one whose evidence no longer holds).
 */
import { describe, expect, it } from "vitest";

import { consolidate } from "./consolidation.js";
import { evidenceOf, verifyDerived } from "./evidence.js";
import { InMemoryStore } from "./in-memory-store.js";
import { exportPortable, importPortable } from "./memory-portability.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

const since = "2000-01-01T00:00:00.000Z";

describe.each([
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
] as [string, () => MemoryStore][])("evidence on derived facts (%s)", (_label, make) => {
  it("a conclusion is written with the quotes it rests on", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "I moved to Berlin in May, for the new job." } }));
    const r = await consolidate(store, {
      since,
      model: "m",
      propose: async () => [{ text: "Lives in Berlin", sourceNodeIds: [a.nodeId], evidence: [{ nodeId: a.nodeId, quote: "moved to  Berlin in\nMay" }] }],
    });
    expect(r.written).toBe(1);
    const d = (await store.getNode(r.derivedNodeIds[0]!))!;
    expect(evidenceOf(d)).toEqual([{ nodeId: a.nodeId, quote: "moved to  Berlin in\nMay" }]);
  });

  it("refuses a conclusion with no quote from a source it cites", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Likes tea" } }));
    const b = await store.addNode(makeNode({ content: { text: "Drinks it black" } }));
    const r = await consolidate(store, {
      since,
      model: "m",
      propose: async () => [{ text: "Drinks black tea", sourceNodeIds: [a.nodeId, b.nodeId], evidence: [{ nodeId: a.nodeId, quote: "Likes tea" }] }],
    });
    expect(r.written).toBe(0);
    expect(r.refused[0]!.why).toBe(`unsupported: no quote from source ${b.nodeId}`);
  });

  it("refuses a conclusion whose quote is not in its source", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Likes tea" } }));
    const r = await consolidate(store, {
      since,
      model: "m",
      propose: async () => [{ text: "Loves coffee", sourceNodeIds: [a.nodeId], evidence: [{ nodeId: a.nodeId, quote: "loves coffee" }] }],
    });
    expect(r.refused[0]!.why).toBe(`unsupported: quote not found in source ${a.nodeId}`);
  });

  it("refuses evidence from a fact the conclusion does not rest on", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Likes tea" } }));
    const b = await store.addNode(makeNode({ content: { text: "Drinks coffee" } }));
    const r = await consolidate(store, {
      since,
      model: "m",
      propose: async () => [{ text: "Likes tea", sourceNodeIds: [a.nodeId], evidence: [{ nodeId: a.nodeId, quote: "Likes tea" }, { nodeId: b.nodeId, quote: "Drinks" }] }],
    });
    expect(r.refused[0]!.why).toBe(`unsupported: evidence cites ${b.nodeId}, which the conclusion does not rest on`);
  });

  it("verifyDerived retracts a conclusion whose evidence no longer holds, keeps the rest, and names what it could not check", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Works at the Tokyo office" } }));
    const good = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Works in Tokyo" }, contextualMetadata: { derivedFrom: [a.nodeId], consolidatedAt: since, evidence: [{ nodeId: a.nodeId, quote: "Tokyo office" }] } }));
    // Arrived by import with evidence that does not match its source.
    const bad = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Works in Osaka" }, contextualMetadata: { derivedFrom: [a.nodeId], consolidatedAt: since, evidence: [{ nodeId: a.nodeId, quote: "Osaka office" }] } }));
    const legacy = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Commutes" }, contextualMetadata: { derivedFrom: [a.nodeId], consolidatedAt: since } }));

    const report = await verifyDerived(store, { now: () => new Date("2026-09-22T12:00:00.000Z") });
    expect(report.checked).toBe(3);
    expect(report.retracted).toEqual([{ nodeId: bad.nodeId, reason: `evidence no longer holds: quote not found in source ${a.nodeId}` }]);
    expect(report.unverifiable).toEqual([legacy.nodeId]);

    const b = (await store.getNode(bad.nodeId))!;
    expect(b.validTo).toBe("2026-09-22T12:00:00.000Z");
    expect(b.contextualMetadata["retraction"]).toMatchObject({ by: "verifyDerived" });
    expect(b.content.text).toBe("Works in Osaka");
    expect((await store.getNode(good.nodeId))!.validTo).toBeNull();
    expect((await store.getNode(legacy.nodeId))!.validTo).toBeNull();

    // Running it again changes nothing: a retracted conclusion is not checked twice.
    expect((await verifyDerived(store)).retracted).toEqual([]);
  });

  it("evidence travels in the portable export and back", async () => {
    const store = make();
    const a = await store.addNode(makeNode({ content: { text: "Likes tea" } }));
    await consolidate(store, { since, model: "m", propose: async () => [{ text: "Tea drinker", sourceNodeIds: [a.nodeId], evidence: [{ nodeId: a.nodeId, quote: "tea" }] }] });
    const exported = await exportPortable(new Map([["p", store]]));
    const into = make();
    await importPortable(exported, () => into);
    const derived = (await into.listNodes()).find((n) => n.provenance === "AIInferred")!;
    expect(evidenceOf(derived)).toEqual([{ nodeId: a.nodeId, quote: "tea" }]);
  });
});
