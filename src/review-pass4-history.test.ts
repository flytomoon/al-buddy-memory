/**
 * Regressions from the post-release review of 0.5.0 (2026-09-22): history and
 * portability. Each case failed on 9ae3bfd.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { exportPortable, importPortable, type PortableExport } from "./memory-portability.js";
import type { HistoryCapable, MemoryStore, NewMemoryNode } from "./types/memory.js";

const fact = (text: string, extra: Partial<NewMemoryNode> = {}): NewMemoryNode => ({
  provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience", privacyClassification: "Private",
  retentionTier: "FullRetention", content: { text }, contextualMetadata: {}, confidenceWeight: 1, decayRate: 0, ...extra,
});
const both: [string, () => MemoryStore & HistoryCapable][] = [
  ["in-memory", () => new InMemoryStore()],
  ["sqlite", () => new SqliteMemoryStore(":memory:")],
];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

afterEach(() => vi.useRealTimers());

describe.each(both)("a refresh import marks the window before it (%s)", (_l, make) => {
  it("a read between the source's change and the import is not served as exact", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-01T00:00:00.000Z"));
    const a = make();
    const f = await a.addNode(fact("refreshed"));
    await a.updateNode(f.nodeId, { confidenceWeight: 0.9 });
    const b = make();
    vi.setSystemTime(Date.parse("2026-09-02T00:00:00.000Z"));
    await importPortable(await exportPortable(new Map([["p", a]])), () => b); // b holds 0.9
    vi.setSystemTime(Date.parse("2026-09-03T00:00:00.000Z"));
    await a.updateNode(f.nodeId, { confidenceWeight: 0.5 }); // only a knows
    vi.setSystemTime(Date.parse("2026-09-05T00:00:00.000Z"));
    await importPortable(await exportPortable(new Map([["p", a]])), () => b); // b learns 0.5 now
    const restored = (await b.history(f.nodeId)).find((v) => v.event === "restored");
    expect(restored?.before.confidenceWeight).toBe(0.9);

    // On 09-04 b still believed 0.9: the joined history cannot vouch for that read.
    const inWindow = await b.getNodeAsOf(f.nodeId, "2026-09-04T00:00:00.000Z");
    expect(inWindow?.exact).toBe(false);
    expect((await b.snapshotAsOf("2026-09-04T00:00:00.000Z")).inexact).toEqual([f.nodeId]);

    // From the import on, the refresh is redundant and the read is exact again.
    const after = await b.getNodeAsOf(f.nodeId, "2026-09-05T00:00:00.000Z");
    expect(after).toMatchObject({ exact: true, node: { confidenceWeight: 0.5 } });
    // Before the source's change nothing is in doubt either.
    const before = await b.getNodeAsOf(f.nodeId, "2026-09-02T12:00:00.000Z");
    expect(before).toMatchObject({ exact: true, node: { confidenceWeight: 0.9 } });
  });
});

describe.each(both)("two projects bound for one store are checked against each other (%s)", (_l, make) => {
  it("a node the two projects disagree about is refused before anything is written", async () => {
    const a = make();
    await a.addNode(fact("shared fact"));
    await a.addNode(fact("written first"));
    const art = clone(await exportPortable(new Map([["p", a]])));
    const other = clone(art.projects[0]!);
    other.project = "q";
    other.nodes = other.nodes.filter((n) => n.content.text === "shared fact");
    other.nodes[0]!.content.text = "a different fact under the same id";
    other.versions = [];
    const dest = make();
    await expect(importPortable({ ...art, projects: [art.projects[0]!, other] }, () => dest)).rejects.toThrow(/immutable/);
    expect(await dest.listNodes()).toEqual([]);
  });

  it("an edge the two projects disagree about is refused before anything is written", async () => {
    const a = make();
    const x = await a.addNode(fact("x"));
    const y = await a.addNode(fact("y"));
    await a.addEdge({ sourceNodeId: x.nodeId, targetNodeId: y.nodeId, relationshipType: "Reinforcement", strength: 0.5, provenance: "UserAsserted" });
    const art = clone(await exportPortable(new Map([["p", a]])));
    const other = clone(art.projects[0]!);
    other.project = "q";
    other.edges[0]!.strength = 0.9;
    const dest = make();
    await expect(importPortable({ ...art, projects: [art.projects[0]!, other] }, () => dest)).rejects.toThrow(/immutable/);
    expect(await dest.listNodes()).toEqual([]);
  });

  it("a second project may lean on a node the first one brings, and identical copies still import", async () => {
    const a = make();
    const x = await a.addNode(fact("x"));
    const y = await a.addNode(fact("y"));
    await a.addEdge({ sourceNodeId: x.nodeId, targetNodeId: y.nodeId, relationshipType: "Reinforcement", strength: 0.5, provenance: "UserAsserted" });
    const art = clone(await exportPortable(new Map([["p", a]])));
    const first = { ...clone(art.projects[0]!), edges: [] };
    const second = { ...clone(art.projects[0]!), project: "q", nodes: [] as PortableExport["projects"][0]["nodes"], versions: [] };
    const dest = make();
    await expect(importPortable({ ...art, projects: [first, second, clone(art.projects[0]!)] }, () => dest)).resolves.toBeDefined();
    expect((await dest.listNodes()).length).toBe(2);
  });
});
