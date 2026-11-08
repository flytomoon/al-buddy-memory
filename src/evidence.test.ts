/**
 * Every derived fact carries the exact words it rests on, and they are checked:
 * on the way in (consolidate refuses a conclusion its sources do not support)
 * and any time after (verifyDerived retracts one whose evidence no longer holds).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { consolidate } from "./consolidation.js";
import { confirmTranscriptRetraction, evidenceOf, verifyDerived } from "./evidence.js";
import { recordRecallHits, recallCount } from "./access.js";
import { InMemoryStore } from "./in-memory-store.js";
import { exportPortable, importPortable } from "./memory-portability.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import type { MemoryStore } from "./types/memory.js";

const since = "2000-01-01T00:00:00.000Z";

it("the access-aware transcript claim in SPEC stays pinned to code", () => {
  const spec = readFileSync(new URL("../docs/SPEC.md", import.meta.url), "utf8");
  expect(spec).toContain("Recall returns append a `recalled` anchor");
  expect(spec).toContain("call the\n`confirm_retraction` MCP tool");
  expect(readFileSync(new URL("./hybrid-retriever.ts", import.meta.url), "utf8")).toContain("recordRecallHits(this.store, hits)");
  expect(readFileSync(new URL("./mcp/governance-server.ts", import.meta.url), "utf8")).toContain('server.tool("confirm_retraction"');
});

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

  it("prioritizes frequently recalled state, checks newer raw turns, and keeps a confirmation receipt", async () => {
    const store = make();
    const oldRaw = await store.addNode(makeNode({ content: { text: "Release 1 is staged" }, memoryType: "Conversation" }));
    const state = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Release 1 is staged" }, contextualMetadata: { stateOf: { subject: "app", key: "app|release" }, derivedFrom: [oldRaw.nodeId], evidence: [{ nodeId: oldRaw.nodeId, quote: "Release 1 is staged" }] } }));
    const other = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "The office is open" }, contextualMetadata: { derivedFrom: [oldRaw.nodeId], evidence: [{ nodeId: oldRaw.nodeId, quote: "Release 1 is staged" }] } }));
    await recordRecallHits(store, [state]);
    await recordRecallHits(store, [state]);
    expect(recallCount((await store.getNode(state.nodeId))!)).toBe(2);
    const later = await store.addNode(makeNode({ content: { text: "Release 2 is live now" }, memoryType: "Conversation" }));
    const order: string[] = [];
    const report = await verifyDerived(store, { maxCrossChecks: 1, crossCheck: async (n, raw) => {
      order.push(n.nodeId);
      expect(raw.map((r) => r.nodeId)).toContain(later.nodeId);
      return { nodeId: later.nodeId, quote: "Release 2 is live now" };
    } });
    expect(order).toEqual([state.nodeId]);
    expect(report.crossChecked).toBe(1);
    expect(report.retracted).toHaveLength(1);
    const withdrawn = (await store.getNode(state.nodeId))!;
    expect(withdrawn.validTo).not.toBeNull();
    expect(withdrawn.contextualMetadata["pendingRetractionConfirmation"]).toMatchObject({ sourceNodeId: later.nodeId });
    expect((await store.getNode(other.nodeId))!.validTo).toBeNull();
    await confirmTranscriptRetraction(store, state.nodeId);
    expect((await store.getNode(state.nodeId))!.contextualMetadata["pendingRetractionConfirmation"]).toBeUndefined();
    expect((await store.getNode(state.nodeId))!.validTo).not.toBeNull();
    expect((await store.getNode(later.nodeId))!.content.text).toBe("Release 2 is live now");
  });

  it("rejects a contradiction that is not quoted from a newer raw turn", async () => {
    const store = make();
    const old = await store.addNode(makeNode({ content: { text: "Old" }, memoryType: "Conversation" }));
    const conclusion = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Old" }, contextualMetadata: { derivedFrom: [old.nodeId], evidence: [{ nodeId: old.nodeId, quote: "Old" }] } }));
    await store.addNode(makeNode({ content: { text: "New" }, memoryType: "Conversation" }));
    await expect(verifyDerived(store, { crossCheck: async () => ({ nodeId: old.nodeId, quote: "Old" }) })).rejects.toThrow(/unsupported contradiction/);
    expect((await store.getNode(conclusion.nodeId))!.validTo).toBeNull();
  });

  it("paces quiet conclusions weekly and read states daily without resetting decay", async () => {
    const store = make();
    const source = await store.addNode(makeNode({ content: { text: "Release staged" }, memoryType: "Conversation" }));
    const state = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Release staged" }, contextualMetadata: { stateOf: { subject: "app", key: "app|release" }, derivedFrom: [source.nodeId], evidence: [{ nodeId: source.nodeId, quote: "Release staged" }] } }));
    const quiet = await store.addNode(makeNode({ provenance: "AIInferred", content: { text: "Other conclusion" }, contextualMetadata: { derivedFrom: [source.nodeId], evidence: [{ nodeId: source.nodeId, quote: "Release staged" }] } }));
    await store.addNode(makeNode({ content: { text: "New raw turn" }, memoryType: "Conversation" }));
    const seen: string[] = [];
    const crossCheck = async (n: { nodeId: string }) => { seen.push(n.nodeId); return null; };
    const t = Date.parse("2026-11-09T00:00:00.000Z");
    expect((await verifyDerived(store, { now: () => new Date(t), crossCheck })).crossChecked).toBe(2);
    expect((await verifyDerived(store, { now: () => new Date(t + 2 * 86_400_000), crossCheck })).crossChecked).toBe(1);
    expect(seen).toEqual([state.nodeId, quiet.nodeId, state.nodeId]);
    expect((await store.getNode(state.nodeId))!.temporalAnchors.at(-1)!.event).toBe("verified");
  });
});
