import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { exportPortable } from "../memory-portability.js";
import { exportView, govern, isRecentlyDeletedCapable, type RecentlyDeletedCapable } from "./governed-store.js";
import type { GovernancePolicy } from "./policy.js";
import { enterpriseAudit } from "./samples.js";

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const };
const fact = (text: string, extra: Record<string, unknown> = {}) => ({ ...base, provenance: "UserInput" as const, content: { text }, ...extra });

const stores: [string, () => MemoryStore][] = [
  ["InMemoryStore", () => new InMemoryStore()],
  ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
];

describe.each(stores)("governance review 2026-09-22 (%s)", (_l, make) => {
  it("restoreDeleted returns nothing the caller could not already see, when the restored fact is hidden from them", async () => {
    // Agents never see `homeAddress`, and never see Archived facts. Everyone may update/erase.
    const policy: GovernancePolicy = {
      name: "redact-and-cold",
      beforeRead(node: MemoryNode, ctx) {
        if (ctx.actor !== "agent") return node;
        if (node.retentionTier === "Archived") return null;
        const { homeAddress: _h, ...rest } = node.contextualMetadata;
        return { ...node, contextualMetadata: rest };
      },
      beforeErase: () => true,
    };
    let actor = "owner";
    const inner = make();
    const store = govern(inner, { policies: [policy], context: () => ({ actor }), recentlyDeleted: { days: 14 } });
    if (!isRecentlyDeletedCapable(store)) throw new Error("no bin");
    const bin = store as MemoryStore & RecentlyDeletedCapable;
    const a = await store.addNode(fact("dentist on thursday", { retentionTier: "Archived", contextualMetadata: { homeAddress: "12 Elm St" } }));
    await store.deleteNode(a.nodeId); // owner bins it; from = Archived
    actor = "agent";
    expect((await store.getNode(a.nodeId))?.contextualMetadata).not.toHaveProperty("homeAddress"); // agent is redacted
    const back = await bin.restoreDeleted(a.nodeId);
    expect(back.contextualMetadata).not.toHaveProperty("homeAddress");
  });

  it("an exporter who is not a reviewer must not export what enterpriseAudit hides from them", async () => {
    const policy = enterpriseAudit({ reviewers: ["reviewer"], exporters: ["exporter"], minInferredConfidence: 0.6 });
    const inner = make();
    const store = govern(inner, { policies: [policy], context: () => ({ actor: "exporter" }) });
    const weak = await store.addNode(fact("Probably dislikes their manager", { provenance: "AIInferred", confidenceWeight: 0.3 }));
    expect(await store.getNode(weak.nodeId)).toBeUndefined(); // hidden from the exporter on every read
    const out = await exportPortable(new Map([["p", exportView(inner, { policies: [policy], context: () => ({ actor: "exporter" }) })]]));
    expect(out.projects[0]!.nodes.map((n) => n.nodeId)).not.toContain(weak.nodeId);
  });

});

describe.each(stores)("enterpriseAudit export still works for a reviewer (%s)", (_l, make) => {
  it("an exporter who is also a reviewer exports the weak facts, and a non-exporter exports nothing", async () => {
    const policy = enterpriseAudit({ reviewers: ["both"], exporters: ["both"], minInferredConfidence: 0.6 });
    const inner = make();
    const store = govern(inner, { policies: [policy], context: () => ({ actor: "both" }) });
    const weak = await store.addNode(fact("Probably dislikes their manager", { provenance: "AIInferred", confidenceWeight: 0.3 }));
    const ids = async (actor: string) =>
      (await exportPortable(new Map([["p", exportView(inner, { policies: [policy], context: () => ({ actor }) })]]))).projects[0]!.nodes.map((n) => n.nodeId);
    expect(await ids("both")).toContain(weak.nodeId);
    expect(await ids("someone")).toEqual([]);
  });
});
