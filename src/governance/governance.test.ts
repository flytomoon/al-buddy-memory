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

/**
 * Review 2026-09-14 (Astra B1/B3, Fable G1/G2): the wrapper governed four
 * methods and passed the rest straight through. Every one of these was
 * reproduced against the shipped code before it was fixed.
 */
describe("governance — no way around the policies", () => {
  function owned() {
    const inner = new InMemoryStore();
    const audit = new MemoryAudit();
    const who = { actor: "owner" };
    const store = govern(inner, { policies: [personalDefaults({ owner: "owner" })], context: () => ({ actor: who.actor }), audit });
    return { inner, audit, who, store };
  }

  it("a fact you cannot read, you cannot update — or read back out of the update", async () => {
    const { inner, audit, who, store } = owned();
    const secret = await store.addNode(fact("password: hunter2"));
    expect(secret.privacyClassification).toBe("Sensitive");

    who.actor = "intruder";
    await expect(store.updateNode(secret.nodeId, {})).rejects.toThrow(/not found/);
    await expect(store.updateNode(secret.nodeId, { privacyClassification: "Private" })).rejects.toThrow(/not found/);
    expect((await inner.getNode(secret.nodeId))?.privacyClassification).toBe("Sensitive");
    expect(audit.events.filter((e) => e.outcome === "denied" && e.actor === "intruder")).toHaveLength(2);

    who.actor = "owner";
    const lowered = await store.updateNode(secret.nodeId, { privacyClassification: "Private" });
    expect(lowered.privacyClassification).toBe("Private");
  });

  it("erasure exists only where a policy allows it, and every attempt is audited", async () => {
    const { inner, audit, who, store } = owned();
    const a = await store.addNode(fact("a"));
    const b = await store.addNode(fact("b"));
    const edge = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Cause", strength: 1, provenance: "UserAsserted" });

    who.actor = "stranger";
    await expect(store.deleteNode(a.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
    await expect(store.deleteEdge(edge.edgeId)).rejects.toBeInstanceOf(PolicyDenied);
    expect(await inner.getNode(a.nodeId)).toBeDefined();

    who.actor = "owner";
    await store.deleteEdge(edge.edgeId);
    await store.deleteNode(a.nodeId);
    expect(await inner.getNode(a.nodeId)).toBeUndefined();
    expect(audit.events.filter((e) => e.purpose === "erase").map((e) => `${e.actor}:${e.outcome}`)).toEqual([
      "stranger:denied",
      "stranger:denied",
      "owner:allowed",
      "owner:allowed",
    ]);

    // No policy that speaks to erasure: nobody erases anything.
    const silent = govern(new InMemoryStore(), { policies: [enterpriseAudit({ reviewers: ["r"], exporters: ["r"] })], context: () => ({ actor: "r" }) });
    const n = await silent.addNode(fact("kept"));
    await expect(silent.deleteNode(n.nodeId)).rejects.toThrow(/erasure is not enabled/);
  });

  it("import runs the write policies: a restored secret is classified, a guardian's fact cannot be restored over", async () => {
    const { store } = owned();
    const scratch = new InMemoryStore();
    const leaked = await scratch.addNode(fact("api_key=sk-live-abcdefghijklmnop1234"));
    await store.restoreNode(leaked);
    expect((await store.getNode(leaked.nodeId))?.privacyClassification).toBe("Sensitive");

    let actor = "parent";
    const guarded = govern(new InMemoryStore(), { policies: [guardianMode({ guardians: ["parent"] })], context: () => ({ actor }) });
    const rule = await guarded.addNode(fact("bedtime is nine", { provenance: "GuardianAdded" }));
    actor = "kid-agent";
    await expect(guarded.restoreNode({ ...rule, validTo: "2026-01-01T00:00:00.000Z" })).rejects.toThrow(/cannot change a guardian's fact/);
  });

  it("a policy that only protects some facts never switches erasure on", async () => {
    let actor = "parent";
    const both = govern(new InMemoryStore(), { policies: [personalDefaults({ owner: "kid" }), guardianMode({ guardians: ["parent"] })], context: () => ({ actor }) });
    const rule = await both.addNode(fact("bedtime is nine", { provenance: "GuardianAdded" }));
    actor = "kid"; // the owner, but not a guardian
    await expect(both.deleteNode(rule.nodeId)).rejects.toThrow(/cannot erase a guardian's fact/);

    const guardianOnly = govern(new InMemoryStore(), { policies: [guardianMode({ guardians: ["parent"] })], context: () => ({ actor: "anyone" }) });
    const plain = await guardianOnly.addNode(fact("likes dinosaurs"));
    await expect(guardianOnly.deleteNode(plain.nodeId)).rejects.toThrow(/erasure is not enabled/);
  });

  it("links to a fact you cannot see are neither made nor shown", async () => {
    const { who, store } = owned();
    const visible = await store.addNode(fact("likes sourdough"));
    const secret = await store.addNode(fact("password: hunter2"));
    await store.addEdge({ sourceNodeId: visible.nodeId, targetNodeId: secret.nodeId, relationshipType: "Cause", strength: 1, provenance: "UserAsserted" });

    who.actor = "intruder";
    expect(await store.getEdges(visible.nodeId)).toEqual([]); // would disclose the secret's id
    await expect(
      store.addEdge({ sourceNodeId: visible.nodeId, targetNodeId: secret.nodeId, relationshipType: "Analogy", strength: 1, provenance: "AIInferred" }),
    ).rejects.toThrow(/not found/); // would confirm the id exists
  });
});
