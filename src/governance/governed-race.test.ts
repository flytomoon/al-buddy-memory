import { describe, expect, it } from "vitest";

import { InMemoryStore } from "../in-memory-store.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";
import { govern } from "./governed-store.js";
import { PolicyDenied, type GovernancePolicy } from "./policy.js";

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
