import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryStore } from "../types/memory.js";
import { MemoryAudit } from "./audit.js";
import { govern } from "./governed-store.js";
import { PolicyDenied } from "./policy.js";
import { memoryLock, personalDefaults } from "./samples.js";

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const };
const fact = (text: string) => ({ ...base, provenance: "UserInput" as const, content: { text } });

const stores: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

describe.each(stores)("memory lock (%s)", (_label, make) => {
  it("refuses erasure by the owner in person, whichever order the policies are in, and audits the refusal", async () => {
    for (const order of ["lock-first", "lock-last"] as const) {
      const inner = make();
      const audit = new MemoryAudit();
      const policies = order === "lock-first" ? [memoryLock(), personalDefaults({ owner: "o" })] : [personalDefaults({ owner: "o" }), memoryLock()];
      const store = govern(inner, { policies, context: () => ({ actor: "o" }), audit });
      const a = await store.addNode(fact("a"));
      const b = await store.addNode(fact("b"));
      const edge = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 1, provenance: "UserAsserted" });

      const refusal = await store.deleteNode(a.nodeId).then(() => null, (err: unknown) => err);
      expect(refusal).toBeInstanceOf(PolicyDenied);
      expect((refusal as PolicyDenied).policy).toBe("memory-lock");
      await expect(store.deleteEdge(edge.edgeId)).rejects.toBeInstanceOf(PolicyDenied);

      expect(await inner.getNode(a.nodeId)).toBeDefined();
      expect(await inner.getEdges(a.nodeId)).toHaveLength(1);
      const erasures = audit.events.filter((e) => e.purpose === "erase");
      expect(erasures.map((e) => `${e.outcome}:${e.policy}`)).toEqual(["denied:memory-lock", "denied:memory-lock"]);
    }
  });

  it("lifts and re-closes with the switch it reads", async () => {
    let locked = true;
    const inner = make();
    const store = govern(inner, { policies: [personalDefaults({ owner: "o" }), memoryLock({ isLocked: () => locked })], context: () => ({ actor: "o" }) });
    const a = await store.addNode(fact("a"));
    const b = await store.addNode(fact("b"));

    await expect(store.deleteNode(a.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    locked = false;
    await store.deleteNode(a.nodeId);
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
    locked = true;
    await expect(store.deleteNode(b.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    expect(await inner.getNode(b.nodeId)).toBeDefined();
  });

  it("stays shut when the switch cannot be read", async () => {
    const inner = make();
    const store = govern(inner, {
      policies: [personalDefaults({ owner: "o" }), memoryLock({ isLocked: () => { throw new Error("settings file unreadable"); } })],
      context: () => ({ actor: "o" }),
    });
    const a = await store.addNode(fact("a"));
    await expect(store.deleteNode(a.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    expect(await inner.getNode(a.nodeId)).toBeDefined();
  });

  it("reads a missing setting as locked: only an explicit false unlocks", async () => {
    const inner = make();
    const settings: Record<string, unknown> = {};
    const store = govern(inner, { policies: [personalDefaults({ owner: "o" }), memoryLock({ isLocked: () => settings["memoryLocked"] as boolean })], context: () => ({ actor: "o" }) });
    const a = await store.addNode(fact("a"));
    await expect(store.deleteNode(a.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    settings["memoryLocked"] = false;
    await store.deleteNode(a.nodeId);
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
  });

  it("does not stop a fact being invalidated: that is how memory changes", async () => {
    const inner = make();
    const store = govern(inner, { policies: [personalDefaults({ owner: "o" }), memoryLock()], context: () => ({ actor: "o" }) });
    const a = await store.addNode(fact("lived in London"));
    const closed = await store.updateNode(a.nodeId, { validTo: new Date().toISOString() });
    expect(closed.validTo).not.toBeNull();
    expect(await inner.getNode(a.nodeId)).toBeDefined();
  });
});
