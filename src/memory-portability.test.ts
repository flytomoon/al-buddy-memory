import { describe, expect, it } from "vitest";
import { exportPortable, importPortable } from "./memory-portability.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { exportView, personalDefaults } from "./governance/index.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryNode, MemoryStore } from "./types/memory.js";

async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const tokyo = await store.addNode(
    makeNode({ memoryType: "Experience", content: { text: "moved to Tokyo" } }),
  );
  const london = await store.addNode(
    makeNode({ memoryType: "Belief", content: { text: "lives in London" } }),
  );
  await store.updateNode(london.nodeId, { validTo: new Date().toISOString() });
  await store.addEdge({
    sourceNodeId: tokyo.nodeId,
    targetNodeId: london.nodeId,
    relationshipType: "Contradiction",
    strength: 0.8,
    provenance: "AIInferred",
  });
  return store;
}

describe("exportPortable", () => {
  it("spans multiple project silos into one artifact", async () => {
    const artifact = await exportPortable(
      new Map([
        ["al-buddy", await seededStore()],
        ["other", new InMemoryStore()],
      ]),
    );
    expect(artifact.formatVersion).toBe("1.1.0");
    expect(artifact.projects.map((p) => p.project).sort()).toEqual(["al-buddy", "other"]);
    const alBuddy = artifact.projects.find((p) => p.project === "al-buddy")!;
    expect(alBuddy.nodes).toHaveLength(2); // retired nodes included — history is the point
    expect(alBuddy.edges).toHaveLength(1);
  });

  it("includes retired (superseded) history, and Sealed nodes too", async () => {
    const store = new InMemoryStore();
    await store.addNode(makeNode({ privacyClassification: "Sealed", content: { text: "s" } }));
    const artifact = await exportPortable(new Map([["p", store]]));
    expect(artifact.projects[0]!.nodes).toHaveLength(1);
  });

  it("EXCLUDES Sealed from the MCP interop view (but keeps it in the lossless owner backup)", async () => {
    const store = new InMemoryStore();
    await store.addNode(
      makeNode({ privacyClassification: "Sealed", content: { text: "sealed secret text" } }),
    );
    await store.addNode(
      makeNode({ privacyClassification: "Private", content: { text: "ordinary fact" } }),
    );
    const artifact = await exportPortable(new Map([["p", store]]));
    // Lossless backup keeps everything.
    expect(artifact.projects[0]!.nodes).toHaveLength(2);
    // The MCP projection (loadable into another AI runtime) must not carry Sealed.
    const mcpText = artifact.mcp.entities.map((e) => e.observations.join(" ")).join(" ");
    expect(mcpText).toContain("ordinary fact");
    expect(mcpText).not.toContain("sealed secret text");
    expect(artifact.mcp.entities).toHaveLength(1);
  });

  it("derives an MCP entities/relations view", async () => {
    const artifact = await exportPortable(new Map([["al-buddy", await seededStore()]]));
    expect(artifact.mcp.entities).toHaveLength(2);
    const entity = artifact.mcp.entities.find((e) => e.observations[0]?.includes("Tokyo"))!;
    expect(entity.entityType).toBe("Experience");
    expect(artifact.mcp.relations).toHaveLength(1);
    expect(artifact.mcp.relations[0]!.relationType).toBe("Contradiction");
  });
});

describe("importPortable — validation + safety", () => {
  it("rejects an artifact with the wrong format version before any write", async () => {
    const target = new InMemoryStore();
    await expect(
      importPortable(
        { formatVersion: "9.9.9", exportedAt: "", projects: [], mcp: { entities: [], relations: [] } } as never,
        () => target,
      ),
    ).rejects.toThrow(/format/i);
  });

  it("rejects a structurally-invalid artifact before touching any store", async () => {
    const target = new InMemoryStore();
    await target.addNode(makeNode({ content: { text: "existing precious memory" } }));
    const bad = {
      formatVersion: "1.0.0",
      exportedAt: "x",
      projects: [{ project: "p", nodes: [{ nodeId: 123 }], edges: [] }],
      mcp: { entities: [], relations: [] },
    };
    await expect(importPortable(bad as never, () => target)).rejects.toThrow();
    // Pre-existing memory must be untouched — validation precedes all writes.
    expect(await target.searchNodes({ query: "precious" })).toHaveLength(1);
  });

  /**
   * The comment above validatePortable promised the WHOLE artifact was checked
   * before any store was touched; it checked the shape of six fields. Every
   * defect below is caught by restoreNode instead — one node too late, so the
   * import left node #1 committed and node #2 refused: a half-imported memory
   * graph, which is precisely what the preflight exists to prevent (Astra R5 +
   * Fable, 2026-09-18).
   */
  describe("refuses the whole artifact before writing any of it", () => {
    const damage: [string, (n: MemoryNode) => MemoryNode][] = [
      ["a confidence outside [0,1]", (n) => ({ ...n, confidenceWeight: 2 })],
      ["a negative decay rate", (n) => ({ ...n, decayRate: -1 })],
      ["no creation anchor", (n) => ({ ...n, temporalAnchors: [{ timestamp: n.validFrom, event: "recalled" }] })],
      ["an anchor event nobody defined", (n) => ({ ...n, temporalAnchors: [...n.temporalAnchors, { timestamp: n.validFrom, event: "invented" as never }] })],
      ["no provenance at all", (n) => { const { provenance: _p, ...rest } = n; return rest as MemoryNode; }],
      ["an invented provenance", (n) => ({ ...n, provenance: "Hacker" as never })],
      ["a privacy classification in the wrong case", (n) => ({ ...n, privacyClassification: "sensitive" as never })],
      ["a retention tier nobody defined", (n) => ({ ...n, retentionTier: "Forever" as never })],
      ["a validFrom with no zone", (n) => ({ ...n, validFrom: "2026-01-01T00:00" })],
      ["an anchor timestamp that is not an instant", (n) => ({ ...n, temporalAnchors: [{ timestamp: "yesterday", event: "created" }] })],
    ];

    for (const [label, damaged] of damage) {
      for (const [store, make] of [["InMemoryStore", () => new InMemoryStore()], ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")]] as const) {
        it(`${store}: ${label}`, async () => {
          const artifact = await exportPortable(new Map([["p", await seededStore()]]));
          const nodes = artifact.projects[0]!.nodes;
          expect(nodes.length).toBe(2);
          nodes[1] = damaged(nodes[1]!);
          const target: MemoryStore = make();
          await expect(importPortable(artifact, () => target)).rejects.toThrow();
          // Not one node in: the artifact was refused, not half-applied.
          expect(await target.listNodes()).toEqual([]);
          (target as { close?: () => void }).close?.();
        });
      }
    }

    it("refuses an edge whose vocabulary or weight is wrong before writing the nodes", async () => {
      for (const damaged of [{ strength: 9 }, { relationshipType: "Friend" as never }, { provenance: "Nobody" as never }]) {
        const artifact = await exportPortable(new Map([["p", await seededStore()]]));
        artifact.projects[0]!.edges[0] = { ...artifact.projects[0]!.edges[0]!, ...damaged };
        const target = new InMemoryStore();
        await expect(importPortable(artifact, () => target)).rejects.toThrow();
        expect(await target.listNodes()).toEqual([]);
      }
    });

    it("refuses an edge whose endpoints the artifact and the destination both lack", async () => {
      const artifact = await exportPortable(new Map([["p", await seededStore()]]));
      artifact.projects[0]!.edges[0] = { ...artifact.projects[0]!.edges[0]!, targetNodeId: "nobody-here" };
      const target = new InMemoryStore();
      await expect(importPortable(artifact, () => target)).rejects.toThrow(/nobody-here/);
      expect(await target.listNodes()).toEqual([]);
    });

    it("refuses an invalid version before writing any nodes", async () => {
      const source = new InMemoryStore();
      const fact = await source.addNode(makeNode());
      await source.updateNode(fact.nodeId, { confidenceWeight: 0.5 });
      const artifact = await exportPortable(new Map([["p", source]]));
      artifact.projects[0]!.versions![0] = { ...artifact.projects[0]!.versions![0]!, recordedAt: "not-an-instant" };
      const target = new InMemoryStore();
      await expect(importPortable(artifact, () => target)).rejects.toThrow(/instant/);
      expect(await target.listNodes()).toEqual([]);
    });

    it("refuses an artifact that would rewrite a fact the destination already holds", async () => {
      const source = await seededStore();
      const artifact = await exportPortable(new Map([["p", source]]));
      const target = new InMemoryStore();
      await importPortable(artifact, () => target);
      const second = await exportPortable(new Map([["p", source]]));
      const nodes = second.projects[0]!.nodes;
      const london = nodes.findIndex((n) => n.content.text === "lives in London");
      nodes[london] = { ...nodes[london]!, content: { text: "a tidier version of what was said" } };
      await expect(importPortable(second, () => target)).rejects.toThrow(/immutable/);
      expect((await target.getNode(nodes[london]!.nodeId))?.content.text).toBe("lives in London");
      // And the first node was not re-written on the way past, either.
      expect((await target.listNodes()).length).toBe(2);
    });
  });
});

/**
 * The artifact must be a state the store actually had. Export enumerated the
 * nodes, then fetched each node's edges one await at a time, so a delete landing
 * in between produced two nodes and zero edges — a graph that never existed
 * (Astra R6, reproduced in both stores, 2026-09-18).
 */
describe("exportPortable is one snapshot", () => {
  for (const [label, make] of [
    ["InMemoryStore", () => new InMemoryStore()],
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
  ] as const) {
    it(`${label}: a write during the export cannot produce a graph that never existed`, async () => {
      const store: MemoryStore = make();
      const a = await store.addNode(makeNode({ content: { text: "one" } }));
      const b = await store.addNode(makeNode({ content: { text: "two" } }));
      await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Temporal", strength: 0.5, provenance: "UserAsserted" });

      const pending = exportPortable(new Map([["p", store]]));
      await store.deleteNode(a.nodeId); // concurrent write, mid-export
      const artifact = await pending;

      const p = artifact.projects[0]!;
      const ids = p.nodes.map((n) => n.nodeId).sort();
      // Either state is honest; a two-node artifact with no edge is not.
      if (ids.length === 2) expect(p.edges).toHaveLength(1);
      else expect(ids).toEqual([b.nodeId]);
      (store as { close?: () => void }).close?.();
    });
  }
});

describe("importPortable — round trip", () => {
  it("reproduces every node and edge exactly in fresh stores", async () => {
    const source = await seededStore();
    const artifact = await exportPortable(new Map([["al-buddy", source]]));

    const targets = new Map([["al-buddy", new InMemoryStore()]]);
    const summary = await importPortable(artifact, (project) => targets.get(project)!);
    expect(summary.nodes).toBe(2);
    expect(summary.edges).toBe(1);

    const target = targets.get("al-buddy")!;
    const originals = await source.searchNodes({ privacyClassification: undefined });
    for (const node of await withSealed(source)) {
      expect(await target.getNode(node.nodeId)).toEqual(node);
    }
    expect(originals.length).toBeGreaterThan(0);
  });

  it("preserves every version and every recorded as-of answer", async () => {
    const source = new InMemoryStore();
    const fact = await source.addNode(makeNode({ validFrom: "2020-01-01T00:00:00.000Z" }));
    await source.updateNode(fact.nodeId, { validFrom: "2021-01-01T00:00:00.000Z", confidenceWeight: 0.8 });
    await source.updateNode(fact.nodeId, { validTo: "2022-01-01T00:00:00.000Z" });
    const artifact = await exportPortable(new Map([["p", source]]));
    const target = new InMemoryStore();
    await importPortable(artifact, () => target);
    const exportedAgain = await exportPortable(new Map([["p", target]]));
    expect(exportedAgain.projects[0]!.versions).toEqual(artifact.projects[0]!.versions);
    for (const version of artifact.projects[0]!.versions ?? []) {
      expect(await target.getNodeAsOf(fact.nodeId, version.recordedAt)).toEqual(await source.getNodeAsOf(fact.nodeId, version.recordedAt));
    }
  });
});

async function withSealed(store: InMemoryStore) {
  const open = await store.searchNodes({});
  const sealed = await store.searchNodes({ privacyClassification: ["Sealed"] });
  return [...open, ...sealed];
}

/**
 * Found by review, 2026-09-14: export enumerated through searchNodes, whose
 * default read hides Archived and PendingDeletion facts — so a "lossless"
 * backup silently dropped them, kept the edges that pointed at them, and SQLite
 * then refused the import halfway through.
 */
describe("exportPortable is complete, in both stores", () => {
  for (const [label, make] of [
    ["InMemoryStore", () => new InMemoryStore()],
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
  ] as const) {
    it(`${label}: every privacy × retention cell leaves, and the artifact imports back whole`, async () => {
      const store: MemoryStore = make();
      const ids: string[] = [];
      for (const privacyClassification of PRIVACY_CLASSIFICATIONS) {
        for (const retentionTier of RETENTION_TIERS) {
          ids.push((await store.addNode(makeNode({ privacyClassification, retentionTier, content: { text: `${privacyClassification}/${retentionTier}` } }))).nodeId);
        }
      }
      const live = ids[1]!; // Public / Summarized
      const archived = ids[2]!; // Public / Archived
      await store.addEdge({ sourceNodeId: live, targetNodeId: archived, relationshipType: "Conceptual", strength: 0.5, provenance: "AIInferred" });

      const artifact = await exportPortable(new Map([["p", store]]));
      expect(artifact.projects[0]!.nodes.map((n) => n.nodeId).sort()).toEqual([...ids].sort());
      expect(artifact.projects[0]!.edges).toHaveLength(1);

      const into = new SqliteMemoryStore(":memory:");
      await expect(importPortable(artifact, () => into)).resolves.toEqual({ nodes: ids.length, edges: 1 });
      expect((await into.listNodes()).map((n) => n.nodeId).sort()).toEqual([...ids].sort());
      (store as { close?: () => void }).close?.();
      into.close();
    });
  }

  it("a filtered export never carries an edge to a node it left out", async () => {
    const store = new InMemoryStore();
    const kept = await store.addNode(makeNode({ content: { text: "kept" } }));
    const hidden = await store.addNode(makeNode({ privacyClassification: "Sensitive", content: { text: "hidden" } }));
    await store.addEdge({ sourceNodeId: kept.nodeId, targetNodeId: hidden.nodeId, relationshipType: "Cause", strength: 1, provenance: "UserAsserted" });
    const view = exportView(store, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: "someone-else" }) });

    const artifact = await exportPortable(new Map([["p", view]]));
    expect(artifact.projects[0]!.nodes.map((n) => n.nodeId)).toEqual([kept.nodeId]);
    // The edge would disclose the hidden fact's id and how it relates.
    expect(artifact.projects[0]!.edges).toEqual([]);
  });
});
