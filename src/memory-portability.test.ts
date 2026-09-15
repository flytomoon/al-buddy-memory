import { describe, expect, it } from "vitest";
import { exportPortable, importPortable } from "./memory-portability.js";
import { InMemoryStore } from "./in-memory-store.js";
import { makeNode } from "./memory-store-conformance.spec.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { exportView, personalDefaults } from "./governance/index.js";
import { PRIVACY_CLASSIFICATIONS, RETENTION_TIERS } from "./types/memory.js";
import type { MemoryStore } from "./types/memory.js";

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
    expect(artifact.formatVersion).toBe("1.0.0");
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
