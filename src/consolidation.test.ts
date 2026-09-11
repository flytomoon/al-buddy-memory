import { describe, expect, it } from "vitest";

import { consolidate } from "./consolidation.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";

async function seed(store: InMemoryStore, texts: string[]) {
  const ids: string[] = [];
  for (const t of texts) ids.push((await store.addNode(makeNode({ content: { text: t } }))).nodeId);
  return ids;
}

describe("consolidate — sleep-time derivation that never touches the raw", () => {
  it("reads recent raw, writes derived facts as NEW nodes linked to their sources, and marks the raw as read", async () => {
    const store = new InMemoryStore();
    const [a, b] = await seed(store, ["He moved to Portland in June.", "His new office is downtown Portland."]);
    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z",
      model: "test-model",
      propose: async (raw) => [{ text: "He lives and works in Portland.", sourceNodeIds: raw.map((r) => r.nodeId), confidence: 0.8 }],
    });
    expect(report).toMatchObject({ read: 2, proposed: 1, written: 1, refused: [] });
    const derived = await store.getNode(report.derivedNodeIds[0]!);
    expect(derived?.provenance).toBe("AIInferred");
    expect(derived?.content.text).toBe("He lives and works in Portland.");
    expect(derived?.contextualMetadata["derivedFrom"]).toEqual([a, b]);
    expect(derived?.confidenceWeight).toBe(0.8);
    const edges = await store.getEdges(derived!.nodeId);
    expect(edges.map((e) => e.targetNodeId).sort()).toEqual([a, b].sort());
    // raw untouched in content; marked as read by an anchor, not rewritten
    const rawA = await store.getNode(a!);
    expect(rawA?.content.text).toBe("He moved to Portland in June.");
    expect(rawA?.temporalAnchors.some((t) => t.event === "summarized")).toBe(true);
  });

  it("does not re-read what a pass already consolidated, and never derives from derived", async () => {
    const store = new InMemoryStore();
    await seed(store, ["fact one"]);
    const propose = async (raw: { nodeId: string }[]) => raw.map((r) => ({ text: "derived from " + r.nodeId, sourceNodeIds: [r.nodeId] }));
    const first = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose });
    const second = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", propose });
    expect(first.written).toBe(1);
    expect(second.read).toBe(0); // the raw is marked; the derived node is AIInferred and skipped
  });

  it("refuses a proposal with no sources or with a source outside the pass — a derived fact must rest on raw", async () => {
    const store = new InMemoryStore();
    await seed(store, ["x"]);
    const report = await consolidate(store, {
      since: "2000-01-01T00:00:00Z", model: "m",
      propose: async () => [{ text: "orphan", sourceNodeIds: [] }, { text: "ghost", sourceNodeIds: ["nope"] }, { text: "", sourceNodeIds: ["nope"] }],
    });
    expect(report.written).toBe(0);
    expect(report.refused.map((r) => r.why)).toEqual([expect.stringContaining("no source"), expect.stringContaining("not in this pass"), "empty"]);
  });

  it("dry run proposes and counts but writes nothing", async () => {
    const store = new InMemoryStore();
    const [a] = await seed(store, ["raw"]);
    const report = await consolidate(store, { since: "2000-01-01T00:00:00Z", model: "m", dryRun: true, propose: async () => [{ text: "d", sourceNodeIds: [a!] }] });
    expect(report.written).toBe(1);
    expect(report.derivedNodeIds).toEqual([]);
    expect((await store.searchNodes({ limit: 10 })).length).toBe(1);
    expect((await store.getNode(a!))?.temporalAnchors.some((t) => t.event === "summarized")).toBe(false);
  });
});
