/**
 * Regressions from the 0.5.0 release review (2026-09-21). Each case failed on
 * the first build of transaction time; each is a way a past read, an update or
 * an import went wrong while looking right.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./in-memory-store.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { exportPortable, importPortable, type PortableExport } from "./memory-portability.js";
import { governanceTools, serverStore } from "./mcp/governance-server.js";
import { govern } from "./governance/governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./governance/policy.js";
import { personalDefaults } from "./governance/samples.js";
import { isHistoryCapable, mutableState } from "./history.js";
import type { HistoryCapable, MemoryStore, NewMemoryNode } from "./types/memory.js";

const fact = (text: string, extra: Partial<NewMemoryNode> = {}): NewMemoryNode => ({
  provenance: "UserInput",
  encryptionKeyRef: "local",
  memoryType: "Experience",
  privacyClassification: "Private",
  retentionTier: "FullRetention",
  content: { text },
  contextualMetadata: {},
  confidenceWeight: 1,
  decayRate: 0,
  ...extra,
});

const tmpDb = () => join(mkdtempSync(join(tmpdir(), "al-buddy-review-")), "m.db");
const both: [string, () => MemoryStore & HistoryCapable][] = [
  ["in-memory", () => new InMemoryStore()],
  ["sqlite", () => new SqliteMemoryStore(":memory:")],
];

describe("legacy rows still accept updates", () => {
  for (const [label, sql] of [
    ["a word outside the vocabulary", `UPDATE memory_nodes SET memory_type = 'Whatever'`],
    ["a weight above 1", `UPDATE memory_nodes SET confidence_weight = 1.5`],
    ["an instant v5 could not parse", `UPDATE memory_nodes SET valid_from = 'sometime'`],
  ] as const) {
    it(`a fact holding ${label} can still be invalidated`, async () => {
      const path = tmpDb();
      let store = new SqliteMemoryStore(path);
      const n = await store.addNode(fact("legacy fact"));
      store.close();
      const raw = new Database(path);
      raw.prepare(sql).run();
      raw.close();
      store = new SqliteMemoryStore(path);
      await expect(store.updateNode(n.nodeId, { validTo: new Date().toISOString() })).resolves.toBeDefined();
      expect(await store.history(n.nodeId)).toHaveLength(1);
      store.close();
    });
  }
});

describe.each(both)("governed history decides and serves one state (%s)", (_label, make) => {
  it("a fact sealed between the check and the read does not leak through history or getNodeAsOf", async () => {
    const inner = make();
    const n = await inner.addNode(fact("where I keep things"));
    const client = serverStore(inner) as MemoryStore & HistoryCapable;
    const history = client.history(n.nodeId);
    const past = client.getNodeAsOf(n.nodeId, "2100-01-01T00:00:00.000Z");
    await inner.updateNode(n.nodeId, { privacyClassification: "Sealed", contextualMetadata: { pin: "4321" } });
    const [h, p] = await Promise.all([history, past]);
    expect(JSON.stringify(h ?? null)).not.toContain("4321");
    expect(JSON.stringify(p ?? null)).not.toContain("4321");
    expect(p?.node.privacyClassification).not.toBe("Sealed");
    expect(await client.getNode(n.nodeId)).toBeUndefined();
  });
});

describe("imports cannot write history nobody recorded", () => {
  it("a version id already used in the destination is refused before anything is written", async () => {
    const dest = new InMemoryStore();
    const a = await dest.addNode(fact("existing"));
    await dest.updateNode(a.nodeId, {}, "reinforced");
    const taken = (await dest.history(a.nodeId))[0]!;

    const src = new InMemoryStore();
    const b = await src.addNode(fact("incoming"));
    await src.updateNode(b.nodeId, { confidenceWeight: 0.5 });
    const artifact = await exportPortable(new Map([["p", src]]));
    artifact.projects[0]!.versions![0] = { ...artifact.projects[0]!.versions![0]!, versionId: taken.versionId };

    await expect(importPortable(artifact, () => dest)).rejects.toThrow(/already recorded/);
    expect(await dest.getNode(b.nodeId)).toBeUndefined();
  });

  it.each(both)("a forged version with no anchor is refused, by the import and by restoreVersion (%s)", async (_label, make) => {
    const src = new InMemoryStore();
    const n = await src.addNode(fact("plain fact"));
    const artifact: PortableExport = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", src]]))));
    const t = new Date(Date.parse(n.temporalAnchors[0]!.timestamp) + 1).toISOString();
    const before = mutableState(n);
    const forged = { versionId: "11111111-1111-4111-8111-111111111111", nodeId: n.nodeId, recordedAt: t, event: "modified" as const, before, after: { ...before, validTo: t } };
    artifact.projects[0]!.versions = [forged];
    const dest = make();
    await expect(importPortable(artifact, () => dest)).rejects.toThrow(/anchor trail/);
    expect(await dest.getNode(n.nodeId)).toBeUndefined();

    await dest.restoreNode(n);
    await expect(dest.restoreVersion(forged)).rejects.toThrow(/anchor trail/);
    const early = { ...forged, versionId: "11111111-1111-4111-8111-111111111112", recordedAt: "2000-01-01T00:00:00.000Z" };
    await expect(dest.restoreVersion(early)).rejects.toThrow(/before its fact was learned/);
  });

  it("an extra key on a version is refused, so both stores re-export the same, schema-valid thing", async () => {
    const src = new InMemoryStore();
    const n = await src.addNode(fact("x"));
    await src.updateNode(n.nodeId, { confidenceWeight: 0.4 });
    const artifact = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", src]])))) as PortableExport;
    const clean = JSON.parse(JSON.stringify(artifact)) as PortableExport;
    (artifact.projects[0]!.versions![0] as unknown as Record<string, unknown>)["payload"] = "x";
    await expect(importPortable(artifact, () => new InMemoryStore())).rejects.toThrow(/exactly/);

    const mem = new InMemoryStore();
    const sql = new SqliteMemoryStore(":memory:");
    await importPortable(clean, () => mem);
    await importPortable(clean, () => sql);
    const [fromMem, fromSql] = await Promise.all([exportPortable(new Map([["p", mem]])), exportPortable(new Map([["p", sql]]))]);
    expect(JSON.stringify(fromMem.projects[0]!.versions)).toBe(JSON.stringify(fromSql.projects[0]!.versions));
  });

  it("a governed import that reshapes a fact says its history no longer vouches for it, and as of now is the fact as stored", async () => {
    const src = new SqliteMemoryStore(":memory:");
    const f = await src.addNode(fact("deploy key AKIAABCDEFGHIJKLMNOP"));
    await src.updateNode(f.nodeId, { confidenceWeight: 0.5 });
    const art = await exportPortable(new Map([["p", src]]));
    const inner = new SqliteMemoryStore(":memory:");
    await importPortable(art, () => govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) }));
    expect((await inner.getNode(f.nodeId))!.privacyClassification).toBe("Sensitive");
    const snap = await inner.snapshotAsOf(new Date(Date.now() + 5).toISOString());
    expect(snap.nodes[0]!.privacyClassification).toBe("Sensitive");
    expect(snap.inexact).toEqual([f.nodeId]);
    expect((await inner.getNodeAsOf(f.nodeId, f.temporalAnchors[0]!.timestamp))?.exact).toBe(false);
  });

  it("a format 1.0.0 artifact still imports", async () => {
    const src = new InMemoryStore();
    await src.addNode(fact("old"));
    const a = JSON.parse(JSON.stringify(await exportPortable(new Map([["p", src]])))) as PortableExport;
    a.formatVersion = "1.0.0";
    delete a.projects[0]!.versions;
    await expect(importPortable(a, () => new SqliteMemoryStore(":memory:"))).resolves.toEqual({ nodes: 1, edges: 0 });
  });
});

describe("restoreVersion is judged on the change it records", () => {
  it("a rule about who may retire a fact stops a version that retires it", async () => {
    const noAgentInvalidate: GovernancePolicy = {
      name: "no-agent-invalidate",
      beforeUpdate(_e, patch, ctx) { if (patch.validTo !== undefined && patch.validTo !== null && ctx.actor !== "owner") throw new PolicyDenied("no-agent-invalidate", "agents cannot retire facts"); },
    };
    const inner = new InMemoryStore();
    const n = await inner.addNode(fact("I work at Acme"));
    const touched = await inner.updateNode(n.nodeId, { confidenceWeight: 0.9 });
    const at = touched.temporalAnchors.at(-1)!.timestamp;
    const s = mutableState(touched);
    const agent = govern(inner, { policies: [noAgentInvalidate], context: () => ({ actor: "agent" }) });
    if (!isHistoryCapable(agent)) throw new Error("history capability was lost");
    // A version that fits the anchor trail, and says the fact was retired.
    const retiring = { versionId: "22222222-2222-4222-8222-222222222222", nodeId: n.nodeId, recordedAt: at, event: "modified" as const, before: s, after: { ...s, validTo: at } };
    await expect(agent.restoreVersion(retiring)).rejects.toBeInstanceOf(PolicyDenied);
    expect(await inner.history(n.nodeId)).toHaveLength(1);
  });
});

describe("the MCP history tool goes through governance", () => {
  it("returns a fact's changes, and nothing for a Sensitive one", async () => {
    const inner = new SqliteMemoryStore(":memory:");
    const tools = governanceTools({ store: serverStore(inner) });
    const f = await tools.remember({ text: "I live in Tokyo" });
    await tools.invalidate({ id: f.id, reason: "moved" });
    expect(await tools.history({ id: f.id })).toHaveLength(1);
    const secret = await inner.addNode(fact("AKIAABCDEFGHIJKLMNOP", { privacyClassification: "Sensitive" }));
    await inner.updateNode(secret.nodeId, { confidenceWeight: 0.3 });
    expect(await tools.history({ id: secret.nodeId })).toEqual([]);
  });
});
