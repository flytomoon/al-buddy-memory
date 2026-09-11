import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { exportPortable } from "../memory-portability.js";
import { MemoryAudit } from "./audit.js";
import { exportView, govern } from "./governed-store.js";
import { PolicyDenied } from "./policy.js";
import { enterpriseAudit, guardianMode, looksSecret, personalDefaults } from "./samples.js";

const base = { encryptionKeyRef: "t", privacyClassification: "Private" as const, retentionTier: "FullRetention" as const, contextualMetadata: {}, decayRate: 0, confidenceWeight: 1, memoryType: "Experience" as const };
const fact = (text: string, extra: Partial<Parameters<InMemoryStore["addNode"]>[0]> = {}) => ({ ...base, provenance: "UserInput" as const, content: { text }, ...extra });

describe("governance — policies in front of the store, audited", () => {
  it("personal defaults: secrets become Sensitive on write; others never see Sensitive; only the owner exports it", async () => {
    const inner = new InMemoryStore();
    const audit = new MemoryAudit();
    let actor = "chris";
    const store = govern(inner, { policies: [personalDefaults({ owner: "chris" })], context: () => ({ actor }), audit });
    const key = await store.addNode(fact("deploy token: token=ghp_abcdefghijklmnopqrstuvwxyz0123"));
    expect(key.privacyClassification).toBe("Sensitive");
    const plain = await store.addNode(fact("Likes sourdough"));
    expect(plain.privacyClassification).toBe("Private");
    // owner sees both (Sensitive must be asked for by name, as the store already requires)
    expect((await store.searchNodes({ privacyClassification: ["Private", "Sensitive"] })).map((n) => n.nodeId).sort()).toEqual([key.nodeId, plain.nodeId].sort());
    actor = "some-agent";
    expect((await store.searchNodes({ privacyClassification: ["Private", "Sensitive"] })).map((n) => n.nodeId)).toEqual([plain.nodeId]);
    expect(await store.getNode(key.nodeId)).toBeUndefined();
    // export as a stranger drops the secret; as the owner keeps it
    const strangerExport = await exportPortable(new Map([["p", exportView(inner, { policies: [personalDefaults({ owner: "chris" })], context: () => ({ actor: "some-agent" }) })]]));
    expect(strangerExport.projects[0]!.nodes.map((n) => n.nodeId)).toEqual([plain.nodeId]);
    const ownerExport = await exportPortable(new Map([["p", exportView(inner, { policies: [personalDefaults({ owner: "chris" })], context: () => ({ actor: "chris" }) })]]));
    expect(ownerExport.projects[0]!.nodes).toHaveLength(2);
    // the trail says what was hidden from whom
    const hidden = audit.events.filter((e) => e.outcome === "hidden");
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.every((e) => e.actor === "some-agent" && e.nodeIds.includes(key.nodeId))).toBe(true);
  });

  it("guardian mode: non-guardians cannot write or change guardian facts, and the refusal is audited", async () => {
    const audit = new MemoryAudit();
    let actor = "parent";
    const store = govern(new InMemoryStore(), { policies: [guardianMode({ guardians: ["parent"] })], context: () => ({ actor }), audit });
    const rule = await store.addNode(fact("No purchases without asking", { provenance: "GuardianAdded" }));
    actor = "kid-agent";
    await expect(store.addNode(fact("Purchases are fine", { provenance: "GuardianAdded" }))).rejects.toBeInstanceOf(PolicyDenied);
    await expect(store.updateNode(rule.nodeId, { validTo: new Date().toISOString() })).rejects.toThrow(/cannot change a guardian's fact/);
    expect((await store.searchNodes({})).map((n) => n.nodeId)).toEqual([rule.nodeId]); // still readable
    const denied = audit.events.filter((e) => e.outcome === "denied");
    expect(denied.map((e) => e.purpose)).toEqual(["write", "invalidate"]);
    expect(denied[0]!.policy).toBe("guardian-mode");
  });

  it("enterprise audit: low-confidence inferences are hidden from non-reviewers; exports need an exporter", async () => {
    let actor = "agent";
    const inner = new InMemoryStore();
    const policy = enterpriseAudit({ reviewers: ["auditor"], exporters: ["auditor"], minInferredConfidence: 0.6 });
    const store = govern(inner, { policies: [policy], context: () => ({ actor }) });
    const weak = await store.addNode(fact("Probably prefers mornings", { provenance: "AIInferred", confidenceWeight: 0.4 }));
    const strong = await store.addNode(fact("Based in Lisbon", { provenance: "AIInferred", confidenceWeight: 0.9 }));
    expect((await store.searchNodes({})).map((n) => n.nodeId)).toEqual([strong.nodeId]);
    actor = "auditor";
    expect((await store.searchNodes({})).map((n) => n.nodeId).sort()).toEqual([weak.nodeId, strong.nodeId].sort());
    const agentExport = await exportPortable(new Map([["p", exportView(inner, { policies: [policy], context: () => ({ actor: "agent" }) })]]));
    expect(agentExport.projects[0]!.nodes).toHaveLength(0);
  });

  it("policies compose in order and ungoverned operations pass through", async () => {
    const inner = new InMemoryStore();
    const store = govern(inner, { policies: [personalDefaults({ owner: "o" }), guardianMode({ guardians: ["o"] })], context: () => ({ actor: "o" }) });
    const a = await store.addNode(fact("a"));
    const b = await store.addNode(fact("b"));
    const edge = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserAsserted" });
    expect(edge.edgeId).toBeTruthy();
    expect(looksSecret("my password: hunter2")).toBe(true);
    expect(looksSecret("likes sourdough")).toBe(false);
    expect(looksSecret("4111 1111 1111 1111")).toBe(true);
  });
});
