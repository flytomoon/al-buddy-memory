import { describe, expect, it, vi } from "vitest";

import { isHistoryCapable } from "../history.js";
import { InMemoryStore } from "../in-memory-store.js";
import { makeNode } from "../memory-store-conformance.spec.js";
import { MemoryAudit } from "./audit.js";
import { govern } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";
import { personalDefaults } from "./samples.js";

describe("governed transaction history", () => {
  it("decides past reads using the fact's current classification", async () => {
    vi.useFakeTimers();
    try {
      const inner = new InMemoryStore();
      vi.setSystemTime("2026-01-01T00:00:00.000Z");
      const fact = await inner.addNode(makeNode({ privacyClassification: "Private" }));
      vi.setSystemTime("2026-02-01T00:00:00.000Z");
      await inner.updateNode(fact.nodeId, { privacyClassification: "Sealed" });
      const hideSealed: GovernancePolicy = { name: "hide-sealed", beforeRead: (node) => node.privacyClassification === "Sealed" ? null : node };
      const audit = new MemoryAudit();
      const store = govern(inner, { policies: [hideSealed], context: () => ({ actor: "reader" }), audit });
      expect(isHistoryCapable(store)).toBe(true);
      if (!isHistoryCapable(store)) return;
      expect(await store.getNodeAsOf(fact.nodeId, "2026-01-01T00:00:00.000Z")).toBeUndefined();
      expect((await store.snapshotAsOf("2026-01-01T00:00:00.000Z")).nodes).toEqual([]);
      expect(await store.history(fact.nodeId)).toEqual([]);
      expect(audit.events.some((event) => event.outcome === "hidden" && event.nodeIds.includes(fact.nodeId))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filtered export snapshots exclude versions for hidden facts", async () => {
    const inner = new InMemoryStore();
    const visible = await inner.addNode(makeNode({ privacyClassification: "Public" }));
    const hidden = await inner.addNode(makeNode({ privacyClassification: "Sealed" }));
    await inner.updateNode(visible.nodeId, { confidenceWeight: 0.8 });
    await inner.updateNode(hidden.nodeId, { confidenceWeight: 0.7 });
    const policy: GovernancePolicy = { name: "hide-sealed", beforeExport: (node) => node.privacyClassification !== "Sealed" };
    const { exportView } = await import("./governed-store.js");
    const view = exportView(inner, { policies: [policy], context: () => ({ actor: "owner" }) });
    if (!isHistoryCapable(view)) throw new Error("history capability was lost");
    const snap = await view.historySnapshot();
    expect(snap.nodes.map((node) => node.nodeId)).toEqual([visible.nodeId]);
    expect(snap.versions.map((version) => version.nodeId)).toEqual([visible.nodeId]);
  });

  it("withholds the history of a fact the read policy redacts today, because past images cannot be redacted", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(makeNode({ contextualMetadata: { diagnosis: "private detail" } }));
    await inner.updateNode(fact.nodeId, { contextualMetadata: { diagnosis: "private detail", seen: true } });
    // Shows the fact, strips a field from it.
    const redact: GovernancePolicy = { name: "redact", beforeRead: (node) => ({ ...node, contextualMetadata: {} }) };
    const store = govern(inner, { policies: [redact], context: () => ({ actor: "reader" }) });
    if (!isHistoryCapable(store)) throw new Error("history capability was lost");
    expect((await store.getNode(fact.nodeId))?.contextualMetadata).toEqual({});
    const leaked = JSON.stringify([
      await store.history(fact.nodeId),
      (await store.getNodeAsOf(fact.nodeId, new Date().toISOString()))?.node,
      await store.snapshotAsOf(new Date().toISOString()),
      (await store.historySnapshot()).versions,
    ]);
    expect(leaked).not.toContain("private detail");
  });

  it("history cannot be planted by an actor the change rules refuse", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(makeNode());
    const [real] = await (async () => { await inner.updateNode(fact.nodeId, { confidenceWeight: 0.9 }); return inner.history(fact.nodeId); })();
    const forged = { ...real!, versionId: "00000000-0000-4000-8000-00000000abcd", after: { ...real!.after, confidenceWeight: 0.1 } };
    const agent = govern(inner, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: "agent" }) });
    if (!isHistoryCapable(agent)) throw new Error("history capability was lost");
    await expect(agent.restoreVersion(forged)).rejects.toBeInstanceOf(PolicyDenied);
    expect(await inner.history(fact.nodeId)).toHaveLength(1);
    const owner = govern(inner, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: "owner" }) });
    if (!isHistoryCapable(owner)) throw new Error("history capability was lost");
    await owner.restoreVersion(forged);
    expect(await inner.history(fact.nodeId)).toHaveLength(2);
  });
});
