/**
 * Regressions from the second 0.5.0 release review (2026-09-21): the fixes to
 * the first review that were narrowed but not closed, and Recently deleted.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { exportPortable, importPortable, type PortableExport } from "./memory-portability.js";
import { serverStore } from "./mcp/governance-server.js";
import { DELETION_REQUEST, exportView, govern, isRecentlyDeletedCapable, type RecentlyDeletedCapable } from "./governance/governed-store.js";
import { MemoryAudit } from "./governance/audit.js";
import { PolicyDenied } from "./governance/policy.js";
import { personalDefaults } from "./governance/samples.js";
import { mutableState } from "./history.js";
import type { HistoryCapable, MemoryStore, NewMemoryNode } from "./types/memory.js";

const fact = (text: string, extra: Partial<NewMemoryNode> = {}): NewMemoryNode => ({
  provenance: "UserInput", encryptionKeyRef: "local", memoryType: "Experience", privacyClassification: "Private",
  retentionTier: "FullRetention", content: { text }, contextualMetadata: {}, confidenceWeight: 1, decayRate: 0, ...extra,
});
const both: [string, () => MemoryStore & HistoryCapable][] = [
  ["in-memory", () => new InMemoryStore()],
  ["sqlite", () => new SqliteMemoryStore(":memory:")],
];

describe("nothing dated after it was written decides the present", () => {
  it.each(both)("a future-dated restored version or anchor is refused, at import and by restoreVersion (%s)", async (_l, make) => {
    const src = new InMemoryStore();
    const n = await src.addNode(fact("plain"));
    const artifact = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", src]])))) as PortableExport;
    const cur = mutableState(n);
    const forged = { versionId: "33333333-3333-4333-8333-333333333333", nodeId: n.nodeId, recordedAt: "2100-01-01T00:00:00.000Z", event: "restored" as const, before: { ...cur, contextualMetadata: { forged: true } }, after: cur };
    await expect(importPortable({ ...artifact, projects: [{ ...artifact.projects[0]!, versions: [forged] }] }, () => make())).rejects.toThrow(/future/);
    const futureAnchor = JSON.parse(JSON.stringify(artifact)) as PortableExport;
    futureAnchor.projects[0]!.nodes[0]!.temporalAnchors.push({ timestamp: "2100-01-01T00:00:00.000Z", event: "modified" });
    await expect(importPortable(futureAnchor, () => make())).rejects.toThrow(/after the export/);
    const dest = make();
    await dest.restoreNode(n);
    await expect(dest.restoreVersion(forged)).rejects.toThrow(/future/);
  });
});

describe("a store can import its own export after repairing a legacy value", () => {
  it("history images are checked for shape, not today's vocabulary", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "al-buddy-pass2-")), "m.db");
    let store = new SqliteMemoryStore(path);
    const n = await store.addNode(fact("legacy"));
    store.close();
    const raw = new Database(path);
    raw.prepare(`UPDATE memory_nodes SET memory_type = 'Whatever'`).run();
    raw.close();
    store = new SqliteMemoryStore(path);
    await store.updateNode(n.nodeId, { memoryType: "Experience" });
    const artifact = await exportPortable(new Map([["p", store]]));
    await expect(importPortable(artifact, () => new SqliteMemoryStore(":memory:"))).resolves.toEqual({ nodes: 1, edges: 0 });
    store.close();
  });
});

describe.each(both)("refreshing a store from a newer backup stays exact (%s)", (_l, make) => {
  it("an import over an existing fact does not mark it inexact for ever", async () => {
    const x = make();
    const f = await x.addNode(fact("refreshed"));
    await x.updateNode(f.nodeId, { confidenceWeight: 0.9 });
    const b = make();
    await importPortable(await exportPortable(new Map([["p", x]])), () => b);
    await x.updateNode(f.nodeId, { confidenceWeight: 0.8 });
    await importPortable(await exportPortable(new Map([["p", x]])), () => b);
    const now = new Date(Date.now() + 5).toISOString();
    expect((await b.getNodeAsOf(f.nodeId, now))?.exact).toBe(true);
    expect((await b.snapshotAsOf(now)).inexact).toEqual([]);
  });
});

describe.each(both)("an erase and an identical re-import between two reads cannot serve the erased history (%s)", (_l, make) => {
  it("the versions are read twice, like the fact", async () => {
    const real = make();
    const original = await real.addNode(fact("where I keep things"));
    let armed = true;
    const hooked = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop === "history") {
          return async (id: string) => {
            if (!armed) return target.history(id);
            armed = false;
            await target.updateNode(id, { privacyClassification: "Private", contextualMetadata: { pin: "4321" } });
            const leaked = await target.history(id);
            await target.deleteNode(id);
            await target.restoreNode(original);
            return leaked;
          };
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const client = serverStore(hooked) as MemoryStore & HistoryCapable;
    expect(JSON.stringify(await client.history(original.nodeId))).not.toContain("4321");
  });
});

describe.each(both)("Recently deleted cannot be entered by the back door (%s)", (_l, make) => {
  const T0 = Date.parse("2026-09-01T12:00:00.000Z");
  const handles = (inner: MemoryStore & HistoryCapable) => {
    const audit = new MemoryAudit();
    const agent = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });
    const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", now: new Date(T0 + 30 * 86_400_000) }), audit, recentlyDeleted: { days: 14 } }) as MemoryStore & RecentlyDeletedCapable;
    return { agent, owner, audit };
  };
  const backdated = { at: "2000-01-01T00:00:00.000Z", from: "FullRetention" };

  it("an actor who may not erase cannot write a deletion request by updating, and the owner's purge erases nothing", async () => {
    const inner = make();
    const { agent, owner } = handles(inner);
    const n = await inner.addNode(fact("the agent may not erase this"));
    await expect(agent.deleteNode(n.nodeId)).rejects.toThrow();
    await expect(agent.updateNode(n.nodeId, { retentionTier: "PendingDeletion", contextualMetadata: { [DELETION_REQUEST]: backdated } })).rejects.toBeInstanceOf(PolicyDenied);
    await expect(agent.updateNode(n.nodeId, { contextualMetadata: { [DELETION_REQUEST]: backdated } })).rejects.toBeInstanceOf(PolicyDenied);
    expect((await owner.purgeDeleted()).purged).toEqual([]);
    expect(await inner.getNode(n.nodeId)).toBeDefined();
  });

  it("nor by importing over a live fact", async () => {
    const inner = make();
    const { owner } = handles(inner);
    const n = await inner.addNode(fact("live"));
    const artifact = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", inner]])))) as PortableExport;
    const node = artifact.projects[0]!.nodes[0]!;
    node.retentionTier = "PendingDeletion";
    node.contextualMetadata = { [DELETION_REQUEST]: backdated };
    artifact.projects[0]!.versions = [];
    // May import and change the owner's facts (actor o) but not erase them (an agent audience).
    const importer = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });
    await expect(importPortable(artifact, () => importer)).rejects.toThrow();
    expect((await owner.purgeDeleted()).purged).toEqual([]);
    expect((await inner.getNode(n.nodeId))?.retentionTier).toBe("FullRetention");
  });

  it("a delete of a fact already pending with no recorded request starts its clock, and every delete is audited", async () => {
    const inner = make();
    const { owner, audit } = handles(inner);
    const n = await inner.addNode(fact("parked by another tool"));
    await inner.updateNode(n.nodeId, { retentionTier: "PendingDeletion" });
    await owner.deleteNode(n.nodeId);
    expect((await owner.listDeleted())[0]?.requestedAt).not.toBeNull();
    await owner.deleteNode(n.nodeId);
    expect(audit.events.filter((e) => e.purpose === "erase" && e.outcome === "allowed")).toHaveLength(2);
  });

  it("an export view built from the same options cannot purge or restore", async () => {
    const inner = make();
    const view = exportView(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }), recentlyDeleted: { days: 14 } });
    expect(isRecentlyDeletedCapable(view)).toBe(false);
  });

  it("an unknown original tier restores as FullRetention instead of trapping the fact", async () => {
    const inner = make();
    const { owner } = handles(inner);
    const n = await inner.addNode(fact("odd tier"));
    await inner.updateNode(n.nodeId, { retentionTier: "PendingDeletion", contextualMetadata: { [DELETION_REQUEST]: { at: "2026-09-01T00:00:00.000Z", from: "Forever" } } });
    expect((await owner.restoreDeleted(n.nodeId)).retentionTier).toBe("FullRetention");
  });
});

describe.each(both)("third review: imports that used to stop part-way (%s)", (_l, make) => {
  it("restoring a backup that holds a Recently deleted fact works under the lock", async () => {
    const src = make();
    const kept = await src.addNode(fact("kept"));
    const binned = await src.addNode(fact("in the bin", { retentionTier: "PendingDeletion", contextualMetadata: { [DELETION_REQUEST]: { at: "2026-09-01T00:00:00.000Z", from: "FullRetention" } } }));
    const artifact = await exportPortable(new Map([["p", src]]));
    const { memoryLock } = await import("./governance/samples.js");
    const dest = make();
    const locked = govern(dest, { policies: [personalDefaults({ owner: "o" }), memoryLock()], context: () => ({ actor: "o" }) });
    await expect(importPortable(artifact, () => locked)).resolves.toEqual({ nodes: 2, edges: 0 });
    expect((await dest.getNode(kept.nodeId))?.retentionTier).toBe("FullRetention");
    expect((await dest.getNode(binned.nodeId))?.retentionTier).toBe("PendingDeletion");
  });

  it("an export dated in the future is refused before anything is written", async () => {
    const src = make();
    const n = await src.addNode(fact("from a fast clock"));
    const artifact = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", src]])))) as PortableExport;
    artifact.exportedAt = new Date(Date.now() + 60_000).toISOString();
    const dest = make();
    await expect(importPortable(artifact, () => dest)).rejects.toThrow(/in the future/);
    expect(await dest.getNode(n.nodeId)).toBeUndefined();
  });
});
