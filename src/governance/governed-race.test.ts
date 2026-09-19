import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";
import { MemoryAudit } from "./audit.js";
import { govern } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";
import { personalDefaults } from "./samples.js";

/**
 * R2 (release review, 2026-09-18): `updateNode` read the fact, awaited the
 * policies — which are async by design (`policy.ts:28-32`) — and then committed
 * against whatever the row had become. An agent's allowed update landed after
 * the owner had made the fact Sensitive, and left it Private and readable.
 *
 * What the fix has to give is a serial order: while one governed mutation is
 * between its authorisation and its commit, no other governed handle over the
 * same store may commit. These tests hold a policy open and check exactly that
 * — the interleaving the review reproduced cannot happen if nothing else can
 * land in the window, and the outcome is then the same as running the two in
 * some order, one after the other.
 *
 * Limit, stated rather than implied: this serialises handles in ONE process.
 * Two processes on one SQLite file are not covered — see docs/GOVERNANCE.md.
 */

const base = {
  provenance: "UserInput" as const,
  encryptionKeyRef: "test",
  memoryType: "Experience" as const,
  retentionTier: "FullRetention" as const,
  contextualMetadata: {},
  confidenceWeight: 1,
  decayRate: 0,
};

function newNode(text: string, privacy: MemoryNode["privacyClassification"] = "Private"): NewMemoryNode {
  return { ...base, privacyClassification: privacy, content: { text } };
}

/** The AI audience cannot see a Sensitive fact; the owner can see everything. */
const sensitiveHiddenFromAI: GovernancePolicy = {
  name: "sensitive-hidden-from-ai",
  beforeRead(node, ctx) {
    return ctx.audience === "ai" && node.privacyClassification === "Sensitive" ? null : node;
  },
};

/** A gate a test can open and close by hand. */
function gate() {
  let reached!: () => void;
  const entered = new Promise<void>((r) => (reached = r));
  let open!: () => void;
  const held = new Promise<void>((r) => (open = r));
  return { entered, held, reach: () => reached(), release: () => open() };
}

/** Long enough that anything not blocked would have finished. */
const settle = () => new Promise((r) => setTimeout(r, 50));

function handles(inner: MemoryStore, extra: GovernancePolicy[]) {
  const policies = [sensitiveHiddenFromAI, ...extra];
  return {
    owner: govern(inner, { policies, context: () => ({ actor: "owner" }) }),
    agent: govern(inner, { policies, context: () => ({ actor: "owner", audience: "ai" }) }),
  };
}

describe("authorisation and mutation are one step", () => {
  it("does not let the owner's restriction land inside an agent's in-flight update (the review's repro)", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("the door code is 4417"));
    const g = gate();
    const pausesTheAgent: GovernancePolicy = {
      name: "pausable",
      async beforeUpdate(_existing, _patch, ctx) {
        if (ctx.audience !== "ai") return;
        g.reach();
        await g.held;
      },
    };
    const { owner, agent } = handles(inner, [pausesTheAgent]);

    // The agent begins an update that its policies allow, and stalls mid-check.
    const agentUpdate = agent.updateNode(fact.nodeId, { privacyClassification: "Private", confidenceWeight: 0.9 });
    await g.entered;

    // The owner tries to make the fact Sensitive while the agent is in the window.
    const ownerUpdate = owner.updateNode(fact.nodeId, { privacyClassification: "Sensitive" });
    await settle();
    // THE DEFECT, on 0.4.1: the owner's write commits here, and the agent then
    // overwrites it with the classification it was authorised for a moment ago.
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Private");

    g.release();
    await Promise.allSettled([agentUpdate, ownerUpdate]);

    // Whichever order they ran in, the last word is the owner's restriction…
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Sensitive");
    // …and the agent cannot reach the fact by any route.
    expect(await agent.getNode(fact.nodeId)).toBeUndefined();
    expect(await agent.searchNodes({ query: "door" })).toHaveLength(0);
  });

  it("refuses an agent update begun after the owner has hidden the fact", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("the door code is 4417"));
    const { owner, agent } = handles(inner, []);
    await owner.updateNode(fact.nodeId, { privacyClassification: "Sensitive" });
    await expect(agent.updateNode(fact.nodeId, { confidenceWeight: 0.5 })).rejects.toThrow(/not found/i);
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Sensitive");
  });

  it("closes the same window on erase", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("erase me if you can"));
    const g = gate();
    const erasable: GovernancePolicy = {
      name: "erasable",
      async beforeErase(_subject, ctx) {
        if (ctx.audience === "ai") {
          g.reach();
          await g.held;
        }
        return true;
      },
    };
    const { owner, agent } = handles(inner, [erasable]);

    const erase = agent.deleteNode(fact.nodeId);
    await g.entered;
    const hide = owner.updateNode(fact.nodeId, { privacyClassification: "Sensitive" });
    await settle();
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Private");

    g.release();
    await Promise.allSettled([erase, hide]);
    // The erase ran first, so the owner's update found nothing to change.
    expect(await inner.getNode(fact.nodeId)).toBeUndefined();
    await expect(hide).rejects.toThrow(/not found/i);
  });

  it("closes the same window on import", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("original"));
    const g = gate();
    const pausesImports: GovernancePolicy = {
      name: "pausable-import",
      async beforeWrite(node, ctx) {
        if (ctx.purpose === "import" && ctx.audience === "ai") {
          g.reach();
          await g.held;
        }
        return node;
      },
    };
    const { owner, agent } = handles(inner, [pausesImports]);

    const restore = agent.restoreNode({ ...fact, confidenceWeight: 0.25 });
    await g.entered;
    const hide = owner.updateNode(fact.nodeId, { privacyClassification: "Sensitive" });
    await settle();
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Private");

    g.release();
    await Promise.allSettled([restore, hide]);
    expect((await inner.getNode(fact.nodeId))?.privacyClassification).toBe("Sensitive");
  });

  it("closes the same window on linking", async () => {
    const inner = new InMemoryStore();
    const a = await inner.addNode(newNode("end a"));
    const b = await inner.addNode(newNode("end b"));
    const g = gate();
    const pausesReads: GovernancePolicy = {
      name: "pausable-read",
      async beforeRead(node, ctx) {
        if (ctx.audience === "ai" && node.nodeId === b.nodeId) {
          g.reach();
          await g.held;
        }
        return node;
      },
    };
    const { owner, agent } = handles(inner, [pausesReads]);

    const link = agent.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Temporal", strength: 1, provenance: "UserInput" });
    await g.entered;
    const hide = owner.updateNode(b.nodeId, { privacyClassification: "Sensitive" });
    await settle();
    expect((await inner.getNode(b.nodeId))?.privacyClassification).toBe("Private");

    g.release();
    await Promise.allSettled([link, hide]);
    expect((await inner.getNode(b.nodeId))?.privacyClassification).toBe("Sensitive");
  });

  it("still refuses what the policies refuse, and still lets many writes through", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("ordinary"));
    const refusing: GovernancePolicy = {
      name: "no-archiving",
      beforeUpdate(_existing, patch) {
        if (patch.retentionTier === "Archived") throw new PolicyDenied("no-archiving", "not allowed");
      },
    };
    const { owner } = handles(inner, [refusing]);
    await expect(owner.updateNode(fact.nodeId, { retentionTier: "Archived" })).rejects.toThrow(PolicyDenied);
    // A refusal must not leave the queue jammed for the next caller.
    await owner.updateNode(fact.nodeId, { confidenceWeight: 0.7 });
    expect((await inner.getNode(fact.nodeId))?.confidenceWeight).toBe(0.7);

    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => owner.addNode(newNode(`concurrent ${i}`))));
    expect(new Set(many.map((n) => n.nodeId)).size).toBe(12);
    await Promise.all(many.map((n) => owner.updateNode(n.nodeId, { confidenceWeight: 0.4 })));
    for (const n of many) expect((await inner.getNode(n.nodeId))?.confidenceWeight).toBe(0.4);
  });
});

/**
 * The regression the R2 fix introduced, found by GPT-6-Astra re-reviewing the
 * merged result on 2026-09-19. Queueing the mutation also moved `context()`
 * inside the queued step, so the authority the call ran under was whatever the
 * caller's context said when the QUEUE reached it — not when the call was made.
 *
 * `context` is documented as "called per operation, so one governed store can
 * serve many actors", and an application that serves many actors sets it from
 * whoever is being served right now. A stranger's mutation, scheduled and then
 * overtaken by the owner's request, therefore committed and audited as the
 * owner. No busy queue was needed: one promise hop is enough.
 *
 * The rule these tests hold: WHO is fixed when the call is made; WHEN is read
 * when the work runs (so an audit event carries the instant it committed).
 */
describe("a queued mutation keeps the authority it was called with", () => {
  /** A store whose caller-identity changes between the call and the queue. */
  function shifting(inner: MemoryStore, policies: GovernancePolicy[]) {
    const audit = new MemoryAudit();
    let actor = "stranger";
    const store = govern(inner, { policies, context: () => ({ actor }), audit });
    return { store, audit, becomeOwner: () => (actor = "owner") };
  }

  it("does not let a stranger's update commit as the owner (the re-review's repro)", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("the door code is 4417"));
    const { store, audit, becomeOwner } = shifting(inner, [personalDefaults({ owner: "owner" })]);

    const pending = store.updateNode(fact.nodeId, { confidenceWeight: 0.1 });
    becomeOwner(); // the next request arrives before the queue runs the step

    await expect(pending).rejects.toThrow();
    expect((await inner.getNode(fact.nodeId))?.confidenceWeight).toBe(1);
    // …and nothing in the trail says the owner did it.
    expect(audit.events.map((e) => e.actor)).not.toContain("owner");
  });

  it("does not let a stranger's erasure run under an owner-only policy", async () => {
    const inner = new InMemoryStore();
    const fact = await inner.addNode(newNode("erase me if you are allowed"));
    const ownerOnlyErase: GovernancePolicy = { name: "owner-only-erase", beforeErase: (_subject, ctx) => ctx.actor === "owner" };
    const { store, becomeOwner } = shifting(inner, [ownerOnlyErase]);

    const pending = store.deleteNode(fact.nodeId);
    becomeOwner();

    await expect(pending).rejects.toThrow(PolicyDenied);
    expect(await inner.getNode(fact.nodeId)).toBeDefined();
  });

  it("does not let a stranger's link reach a fact only the owner may see", async () => {
    const inner = new InMemoryStore();
    const a = await inner.addNode(newNode("end a"));
    const b = await inner.addNode(newNode("end b"));
    const ownerOnlyRead: GovernancePolicy = { name: "owner-only-read", beforeRead: (node, ctx) => (ctx.actor === "owner" ? node : null) };
    const { store, becomeOwner } = shifting(inner, [ownerOnlyRead]);

    const pending = store.addEdge({ sourceNodeId: a.nodeId, targetNodeId: b.nodeId, relationshipType: "Reinforcement", strength: 1, provenance: "UserAsserted" });
    becomeOwner();

    await expect(pending).rejects.toThrow(/not found/i);
    expect(await inner.getEdges(a.nodeId)).toHaveLength(0);
  });

  // A guard, not a repro: `addNode` read its context at call time already, and
  // serialising it (the fix for the audit-latch bound) must not move that read
  // into the queued step the way the R2 fix did for everything else.
  it("writes a new fact as the actor who asked for it", async () => {
    const inner = new InMemoryStore();
    const { store, audit, becomeOwner } = shifting(inner, []);
    const pending = store.addNode(newNode("who wrote this?"));
    becomeOwner();
    await pending;
    expect(audit.events.map((e) => e.actor)).toEqual(["stranger"]);
  });

  // The other half of the rule, so the fix for the above does not go too far:
  // the CLOCK is still read when the queued work runs. Freezing the whole
  // context at call time would backdate every event behind a slow policy.
  it("reads the clock when the queued work runs, not when the call was made", async () => {
    const inner = new InMemoryStore();
    const a = await inner.addNode(newNode("first"));
    const b = await inner.addNode(newNode("second"));
    const audit = new MemoryAudit();
    const g = gate();
    const holdsTheQueue: GovernancePolicy = {
      name: "holds-the-queue",
      async beforeUpdate(existing) {
        if (existing.nodeId === a.nodeId) {
          g.reach();
          await g.held;
        }
      },
    };
    const store = govern(inner, { policies: [holdsTheQueue], context: () => ({ actor: "owner" }), audit });

    const first = store.updateNode(a.nodeId, { confidenceWeight: 0.5 });
    await g.entered;
    const queued = store.updateNode(b.nodeId, { confidenceWeight: 0.5 }); // called now, runs later
    const calledAt = Date.now();
    await new Promise((r) => setTimeout(r, 25));
    g.release();
    await Promise.all([first, queued]);

    const forB = audit.events.find((e) => e.outcome === "allowed" && e.nodeIds.includes(b.nodeId));
    expect(Date.parse(forB!.at)).toBeGreaterThan(calledAt);
  });
});
