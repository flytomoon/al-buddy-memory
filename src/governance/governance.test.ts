import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import { SqliteMemoryStore } from "../sqlite-memory-store.js";
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
    // Refused by guardian mode — the write rule fires first now that the update
    // rules judge the shaped import; either way the guardian's fact stands.
    await expect(guarded.restoreNode({ ...rule, validTo: "2026-01-01T00:00:00.000Z" })).rejects.toThrow(/^guardian-mode: /);
    actor = "parent";
    expect((await guarded.getNode(rule.nodeId))?.validTo).toBeNull();
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

  it("the embedding cache neither confirms nor touches a fact you cannot see", async () => {
    const { who, store } = owned();
    const secret = await store.addNode(fact("password: hunter2"));
    await store.setEmbedding({ nodeId: secret.nodeId, model: "m", modelVersion: "1", dimensions: 1, metric: "cosine", vector: [1] });

    who.actor = "intruder";
    const probe = (nodeId: string) => store.setEmbedding({ nodeId, model: "m", modelVersion: "1", dimensions: 1, metric: "cosine", vector: [0] });
    // A hidden fact and a missing one must fail the same way (Astra re-review:
    // the hidden one succeeded, the missing one hit a foreign key).
    await expect(probe(secret.nodeId)).rejects.toThrow(/not found/);
    await expect(probe("00000000-0000-4000-8000-00000000abcd")).rejects.toThrow(/not found/);
    expect(await store.getEmbeddings(secret.nodeId)).toEqual([]);
    expect(await store.listEmbeddings("m")).toEqual([]);
    await expect(store.deleteEmbeddings(secret.nodeId)).rejects.toThrow(/not found/);

    who.actor = "owner";
    expect((await store.getEmbeddings(secret.nodeId))[0]?.vector).toEqual([1]);
  });

  it("a link you may not erase, you may not rewrite by re-importing it", async () => {
    const { who, store } = owned();
    const a = await store.addNode(fact("a"));
    const b = await store.addNode(fact("b"));
    const secret = await store.addNode(fact("password: hunter2"));
    const link = await store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: secret.nodeId, relationshipType: "Cause", strength: 1, provenance: "UserAsserted" });

    who.actor = "intruder";
    await expect(store.restoreEdge({ ...link, targetNodeId: b.nodeId, relationshipType: "Contradiction" })).rejects.toThrow();
    who.actor = "owner";
    expect((await store.getEdges(a.nodeId)).map((e) => e.targetNodeId)).toEqual([secret.nodeId]);
  });

  it("the update policies judge an import AFTER the write policies have shaped it", async () => {
    const inner = new InMemoryStore();
    const existing = await inner.addNode(fact("to be imported over"));
    const policy = {
      name: "no-archiving",
      beforeWrite: (n: Parameters<InMemoryStore["addNode"]>[0], ctx: { purpose: string }) => (ctx.purpose === "import" ? { ...n, retentionTier: "Archived" as const } : n),
      beforeUpdate: (_e: unknown, patch: { retentionTier?: string }) => {
        if (patch.retentionTier === "Archived") throw new PolicyDenied("no-archiving", "archiving is not allowed");
      },
    };
    const store = govern(inner, { policies: [policy], context: () => ({ actor: "x" }) });
    await expect(store.restoreNode(existing)).rejects.toThrow(/archiving is not allowed/);
    expect((await inner.getNode(existing.nodeId))?.retentionTier).toBe("FullRetention");
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

/**
 * Fable re-review, 2026-09-15: govern() returned a Proxy that forwarded every
 * property the inner store had. As a stranger, `getNode(secretId)` was
 * undefined and `governed.db.prepare("SELECT …").all()` returned the secret; on
 * InMemoryStore `governed.nodes` was the live Map. "The governed handle is the
 * boundary" was false on the day it became the headline.
 */
describe("the governed handle exposes nothing but governed methods", () => {
  const METHODS = [
    "addNode", "getNode", "searchNodes", "listNodes", "updateNode", "deleteNode", "restoreNode", "restoreEdge",
    "addEdge", "getEdges", "deleteEdge", "setEmbedding", "getEmbeddings", "listEmbeddings", "deleteEmbeddings",
  ].sort();

  for (const [label, make] of [
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
    ["InMemoryStore", () => new InMemoryStore()],
  ] as const) {
    it(`${label}: no database, no maps, no route to the inner store`, async () => {
      const inner = make();
      const g = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "stranger" }) });
      const loose = g as unknown as Record<string, unknown>;
      for (const prop of ["db", "nodes", "edges", "embeddings", "size", "close"]) {
        expect(loose[prop], prop).toBeUndefined();
      }
      expect(loose["constructor"]).not.toBe(inner.constructor); // a plain object, not the store's class
      expect(Object.keys(g).sort()).toEqual(METHODS);
      (inner as { close?: () => void }).close?.();
    });
  }
});

/**
 * Fable final review, 2026-09-15: the governed read filtered AFTER the inner
 * limit, so hidden facts used up page slots. As the AI audience,
 * recall("password", limit 1) came back empty while limit 50 found the
 * visible fact — the agent learns that the best matches for any word it tries
 * are facts it is not allowed to see. The `after` cursor answered differently
 * for a hidden id than for a missing one.
 */
describe("a governed read never lets a hidden fact take a place on the page", () => {
  it("a probe with a hidden cursor leaves a trace for the operator, and nothing for the actor", async () => {
    const inner = new InMemoryStore();
    const audit = new MemoryAudit();
    const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    const secret = await owner.addNode(fact("password: hunter2"));
    const ai = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }), audit });
    expect(await ai.searchNodes({ after: secret.nodeId })).toEqual([]);
    expect(audit.events.some((e) => e.outcome === "hidden" && e.nodeIds.includes(secret.nodeId))).toBe(true);
  });

  for (const [label, make] of [
    ["SqliteMemoryStore", () => new SqliteMemoryStore(":memory:")],
    ["InMemoryStore", () => new InMemoryStore()],
  ] as const) {
    it(`${label}: the page is the first visible facts, and a hidden cursor behaves like a missing one`, async () => {
      const inner = make();
      const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
      const visible = await owner.addNode(fact("password reset procedure is in the wiki"));
      const hidden: string[] = [];
      for (let i = 0; i < 30; i++) hidden.push((await owner.addNode(fact(`password: secret-${i}`))).nodeId);
      const ai = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });

      for (const limit of [1, 5]) {
        const page = await ai.searchNodes({ query: "password", limit });
        expect(page.map((n) => n.nodeId)).toEqual([visible.nodeId]);
      }
      const noQuery = await ai.searchNodes({ limit: 1 });
      expect(noQuery.map((n) => n.nodeId)).toEqual([visible.nodeId]);

      // A fractional limit from the library handle used to skip the page-full check.
      expect((await ai.searchNodes({ query: "password", limit: 2.7 })).map((n) => n.nodeId)).toEqual([visible.nodeId]);

      const afterHidden = await ai.searchNodes({ after: hidden[0]! });
      const afterMissing = await ai.searchNodes({ after: "00000000-0000-4000-8000-00000000dead" });
      expect(afterHidden).toEqual(afterMissing);
      (inner as { close?: () => void }).close?.();
    });
  }
});

/** Fable final review, 2026-09-15 — the smaller holes in the samples and views. */
describe("the samples and views keep their own words", () => {
  it("personalDefaults judges export and erasure by audience as well as actor, as it already did reads", async () => {
    const inner = new InMemoryStore();
    const asOwner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    const secret = await asOwner.addNode(fact("password: hunter2"));
    const plain = await asOwner.addNode(fact("likes sourdough"));
    const forAgent = { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) };

    expect(await exportView(inner, forAgent).getNode(secret.nodeId)).toBeUndefined();
    const artifact = await exportPortable(new Map([["p", exportView(inner, forAgent)]]));
    expect(artifact.projects[0]!.nodes.map((n) => n.nodeId)).toEqual([plain.nodeId]);
    await expect(govern(inner, forAgent).deleteNode(plain.nodeId)).rejects.toBeInstanceOf(PolicyDenied);
  });

  it("personalDefaults lets only the owner change the owner's facts", async () => {
    const inner = new InMemoryStore();
    const asOwner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    const n = await asOwner.addNode(fact("lives in Lisbon"));
    const stranger = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "stranger" }) });
    await expect(stranger.updateNode(n.nodeId, { retentionTier: "PendingDeletion" })).rejects.toBeInstanceOf(PolicyDenied);
    await expect(stranger.updateNode(n.nodeId, { validTo: new Date().toISOString() })).rejects.toBeInstanceOf(PolicyDenied);
    // An agent acting FOR the owner still can: that is how an assistant invalidates a fact.
    const agent = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });
    expect((await agent.updateNode(n.nodeId, { validTo: "2026-01-01T00:00:00Z" })).validTo).toBe("2026-01-01T00:00:00.000Z");
  });

  it("an exportView is read-only, as it says", async () => {
    const inner = new InMemoryStore();
    const n = await inner.addNode(fact("kept"));
    const view = exportView(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    await expect(view.deleteNode(n.nodeId)).rejects.toThrow(/read-only/);
    await expect(view.addNode(fact("new"))).rejects.toThrow(/read-only/);
    await expect(view.updateNode(n.nodeId, { confidenceWeight: 0.1 })).rejects.toThrow(/read-only/);
    expect(await inner.getNode(n.nodeId)).toBeDefined();
  });
});

/**
 * Astra final review, 2026-09-15 (B1): the governed methods checked an input
 * object, awaited, then used the SAME object — so a caller in the same process
 * could pass a visible id, pass the check, and swap in a hidden id before the
 * write. Every input is now copied at the call.
 */
describe("a governed call acts on the arguments as they were when it was made", () => {
  it("swapping the target after the call cannot write to a hidden fact", async () => {
    for (const make of [() => new InMemoryStore(), () => new SqliteMemoryStore(":memory:")]) {
      const inner = make();
      const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
      const visible = await owner.addNode(fact("likes sourdough"));
      const hidden = await owner.addNode(fact("password: hunter2"));
      const ai = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o", audience: "agent" }) });

      const e = { nodeId: visible.nodeId, model: "m", modelVersion: "1", dimensions: 1, metric: "cosine" as const, vector: [1] };
      const pending = ai.setEmbedding(e);
      e.nodeId = hidden.nodeId; // swapped after the check has started
      await pending;
      expect(await inner.getEmbeddings(hidden.nodeId)).toEqual([]);
      expect(await inner.getEmbeddings(visible.nodeId)).toHaveLength(1);

      const link = { sourceNodeId: visible.nodeId, targetNodeId: visible.nodeId, relationshipType: "Cause" as const, strength: 1, provenance: "AIInferred" as const };
      const linking = ai.addEdge(link);
      link.targetNodeId = hidden.nodeId;
      const made = await linking;
      expect(made.targetNodeId).toBe(visible.nodeId);

      const secret = fact("an ordinary note");
      const writing = owner.addNode(secret);
      secret.content = { text: "api_key=sk-live-abcdefghijklmnop1234" }; // would dodge classification
      const written = await writing;
      expect(written.content.text).toBe("an ordinary note");

      // The copy is the JSON the store itself would keep: a function in metadata is
      // dropped rather than refused, and toJSON is honoured (structuredClone threw).
      const odd = await owner.addNode(fact("with odd metadata", { contextualMetadata: { f: () => 1, when: { toJSON: () => "2026-01-01" } } as never }));
      expect(odd.contextualMetadata).toEqual({ when: "2026-01-01" });
      (inner as { close?: () => void }).close?.();
    }
  });
});

/** Astra final review (B4): import was "owner-grade" only in the docs, and answered differently for hidden and missing ids. */
describe("import is authorised before anything depends on whether the fact exists", () => {
  it("a stranger's import is refused the same way for a hidden fact and a missing one", async () => {
    const inner = new InMemoryStore();
    const owner = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "o" }) });
    const hidden = await owner.addNode(fact("password: hunter2"));
    const stranger = govern(inner, { policies: [personalDefaults({ owner: "o" })], context: () => ({ actor: "stranger" }) });
    const missing = { ...hidden, nodeId: "00000000-0000-4000-8000-00000000beef" };
    const errorOf = async (p: Promise<unknown>) => p.then(() => "resolved", (e: Error) => `${e.name}: ${e.message}`);
    const a = await errorOf(stranger.restoreNode(hidden));
    const b = await errorOf(stranger.restoreNode(missing));
    expect(a).toMatch(/PolicyDenied/);
    expect(a).toBe(b);
    expect(await inner.getNode(missing.nodeId)).toBeUndefined();
    // the owner still imports
    await owner.restoreNode(missing);
    expect(await inner.getNode(missing.nodeId)).toBeDefined();
  });
});
