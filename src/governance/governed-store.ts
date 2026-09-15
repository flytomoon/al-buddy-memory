/**
 * govern(store, …) — the same MemoryStore, with policies in front of every
 * operation that can change a fact or reveal one, and an audit event for each.
 *
 * The capability model: hand callers the governed handle and keep the inner
 * store to yourself. A caller holding the inner store is not governed by
 * anything — that is what "the raw store" means.
 *
 * Governed: addNode, updateNode, restoreNode (import), deleteNode/deleteEdge
 * (erasure), addEdge/restoreEdge, getNode, searchNodes, listNodes, getEdges.
 * Passed through: the embedding cache (setEmbedding, getEmbeddings,
 * listEmbeddings, deleteEmbeddings) — vectors are derived, disposable, and
 * never returned as facts. Until 2026-09-14 edges, restore and delete passed
 * through too, and a stranger could erase a guardian's fact with no audit.
 */
import type { MemoryEdge, MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";
import { AUDIT_ID_SAMPLE, type AuditSink } from "./audit.js";
import { PolicyDenied, type ErasureSubject, type GovernancePolicy, type NodePatch, type PolicyContext, type Purpose } from "./policy.js";

export interface GovernOptions {
  policies: GovernancePolicy[];
  /** Who is acting right now. Called per operation, so one governed store can serve many actors. */
  context: (purpose: Purpose) => Omit<PolicyContext, "purpose" | "now"> & { now?: Date };
  audit?: AuditSink | undefined;
  /** What a read counts as. exportView sets "export" so beforeExport decides instead of beforeRead. */
  readAs?: "recall" | "export" | undefined;
}

function ctxFor(opts: GovernOptions, purpose: Purpose): PolicyContext {
  const c = opts.context(purpose);
  return { actor: c.actor, audience: c.audience, purpose, now: c.now ?? new Date() };
}

async function record(opts: GovernOptions, ctx: PolicyContext, outcome: "allowed" | "denied" | "hidden", ids: string[], extra: { policy?: string; reason?: string } = {}): Promise<void> {
  if (!opts.audit) return;
  await opts.audit.record({ at: ctx.now.toISOString(), actor: ctx.actor, audience: ctx.audience, purpose: ctx.purpose, outcome, nodeIds: ids.slice(0, AUDIT_ID_SAMPLE), count: ids.length, policy: extra.policy, reason: extra.reason });
}

/** One fact as this actor would see it on a read: the node (possibly redacted), or null. No audit. */
async function view(opts: GovernOptions, node: MemoryNode, ctx: PolicyContext): Promise<MemoryNode | null> {
  let current: MemoryNode | null = node;
  for (const p of opts.policies) {
    if (current === null) break;
    if (ctx.purpose === "export" && p.beforeExport) {
      if (!(await p.beforeExport(current, ctx))) current = null;
    } else if (p.beforeRead) {
      current = await p.beforeRead(current, ctx);
    }
  }
  return current;
}

async function filterRead(opts: GovernOptions, nodes: MemoryNode[], ctx: PolicyContext): Promise<MemoryNode[]> {
  const out: MemoryNode[] = [];
  const hidden: string[] = [];
  for (const node of nodes) {
    const seen = await view(opts, node, ctx);
    if (seen === null) hidden.push(node.nodeId);
    else out.push(seen);
  }
  if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
  await record(opts, ctx, "allowed", out.map((n) => n.nodeId));
  return out;
}

/** Run a policy step; a refusal is audited, then rethrown. */
async function guarded<T>(opts: GovernOptions, ctx: PolicyContext, ids: string[], step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (err instanceof PolicyDenied) await record(opts, ctx, "denied", ids, { policy: err.policy, reason: err.reason });
    throw err;
  }
}

/** The mutable part of a restored fact, as the patch an update would carry. */
function asPatch(node: MemoryNode): NodePatch {
  return {
    memoryType: node.memoryType,
    privacyClassification: node.privacyClassification,
    retentionTier: node.retentionTier,
    contextualMetadata: node.contextualMetadata,
    confidenceWeight: node.confidenceWeight,
    decayRate: node.decayRate,
    validFrom: node.validFrom,
    validTo: node.validTo,
  };
}

export function govern(inner: MemoryStore, opts: GovernOptions): MemoryStore {
  const readCtx = () => ctxFor(opts, opts.readAs ?? "recall");

  /**
   * The fact, if this actor may see it — else "not found", audited as denied.
   * Refusing with "not found" rather than "denied" is deliberate: an actor who
   * cannot read a fact must not learn from the error that it exists.
   */
  async function visibleOrNotFound(nodeId: string, ctx: PolicyContext): Promise<{ node: MemoryNode; seen: MemoryNode }> {
    const node = await inner.getNode(nodeId);
    const seen = node ? await view(opts, node, { ...ctx, purpose: "recall" }) : null;
    if (!node || !seen) {
      if (node) await record(opts, ctx, "denied", [nodeId], { reason: "not visible to this actor" });
      throw new Error(`Memory node not found: ${nodeId}`);
    }
    return { node, seen };
  }

  async function writePolicies(node: NewMemoryNode, ctx: PolicyContext): Promise<NewMemoryNode> {
    let current = node;
    for (const p of opts.policies) if (p.beforeWrite) current = await p.beforeWrite(current, ctx);
    return current;
  }

  async function erasePolicies(subject: ErasureSubject, ctx: PolicyContext): Promise<void> {
    let allowed = false;
    for (const p of opts.policies) if (p.beforeErase && (await p.beforeErase(subject, ctx)) === true) allowed = true;
    if (!allowed) throw new PolicyDenied("govern", "erasure is not enabled: no policy allows it");
  }

  const governed: Partial<MemoryStore> = {
    async addNode(node: NewMemoryNode): Promise<MemoryNode> {
      const ctx = ctxFor(opts, "write");
      const current = await guarded(opts, ctx, [], () => writePolicies(node, ctx));
      const saved = await inner.addNode(current);
      await record(opts, ctx, "allowed", [saved.nodeId]);
      return saved;
    },

    async updateNode(nodeId, patch, anchorEvent): Promise<MemoryNode> {
      const ctx = ctxFor(opts, patch.validTo !== undefined ? "invalidate" : "write");
      // A fact this actor cannot read is a fact this actor cannot change, and
      // its text must not come back in the response. This used to fetch the
      // node unfiltered, so `updateNode(secretId, {})` returned the secret and
      // `{ privacyClassification: "Private" }` made it readable for good.
      const { node: existing, seen } = await visibleOrNotFound(nodeId, ctx);
      await guarded(opts, ctx, [nodeId], async () => {
        for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, patch, ctx);
      });
      const updated = anchorEvent === undefined ? await inner.updateNode(nodeId, patch) : await inner.updateNode(nodeId, patch, anchorEvent);
      await record(opts, ctx, "allowed", [nodeId]);
      // What they could already see, plus what they themselves wrote.
      return (await view(opts, updated, { ...ctx, purpose: "recall" })) ?? { ...seen, ...patch, temporalAnchors: updated.temporalAnchors };
    },

    async restoreNode(node: MemoryNode): Promise<void> {
      const ctx = ctxFor(opts, "import");
      const existing = await inner.getNode(node.nodeId);
      let incoming = node;
      await guarded(opts, ctx, [node.nodeId], async () => {
        if (existing) {
          if (!(await view(opts, existing, { ...ctx, purpose: "recall" }))) throw new PolicyDenied("govern", "cannot restore over a fact this actor cannot read");
          for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, asPatch(node), ctx);
        }
        // The write policies see an import exactly as they see a new fact, so a
        // restored secret is classified the same way a written one is.
        const { nodeId, temporalAnchors, validFrom, validTo, ...fields } = node;
        const written = await writePolicies({ ...fields, validFrom, validTo }, ctx);
        incoming = { ...node, ...written, nodeId, temporalAnchors };
      });
      await inner.restoreNode(incoming);
      await record(opts, ctx, "allowed", [node.nodeId]);
    },

    async deleteNode(nodeId: string): Promise<void> {
      const ctx = ctxFor(opts, "erase");
      const { node } = await visibleOrNotFound(nodeId, ctx);
      await guarded(opts, ctx, [nodeId], () => erasePolicies({ node }, ctx));
      await inner.deleteNode(nodeId);
      await record(opts, ctx, "allowed", [nodeId]);
    },

    async deleteEdge(edgeId: string): Promise<void> {
      const ctx = ctxFor(opts, "erase");
      await guarded(opts, ctx, [], () => erasePolicies({ edgeId }, ctx));
      await inner.deleteEdge(edgeId);
      await record(opts, ctx, "allowed", [], { reason: `edge ${edgeId}` });
    },

    async addEdge(edge): Promise<MemoryEdge> {
      const ctx = ctxFor(opts, "write");
      // Linking to a hidden fact would confirm that its id exists.
      await visibleOrNotFound(edge.sourceNodeId, ctx);
      await visibleOrNotFound(edge.targetNodeId, ctx);
      const saved = await inner.addEdge(edge);
      await record(opts, ctx, "allowed", [edge.sourceNodeId, edge.targetNodeId], { reason: `edge ${saved.edgeId}` });
      return saved;
    },

    async restoreEdge(edge: MemoryEdge): Promise<void> {
      const ctx = ctxFor(opts, "import");
      await visibleOrNotFound(edge.sourceNodeId, ctx);
      await visibleOrNotFound(edge.targetNodeId, ctx);
      await inner.restoreEdge(edge);
      await record(opts, ctx, "allowed", [edge.sourceNodeId, edge.targetNodeId], { reason: `edge ${edge.edgeId}` });
    },

    async getEdges(nodeId: string): Promise<MemoryEdge[]> {
      const ctx = readCtx();
      if (!(await governed.getNode!(nodeId))) return [];
      const out: MemoryEdge[] = [];
      for (const edge of await inner.getEdges(nodeId)) {
        const other = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
        const node = await inner.getNode(other);
        // An edge to a hidden fact discloses the hidden fact's id and relation.
        if (node && (await view(opts, node, ctx))) out.push(edge);
      }
      return out;
    },

    async getNode(nodeId: string): Promise<MemoryNode | undefined> {
      const node = await inner.getNode(nodeId);
      if (!node) return undefined;
      const [visible] = await filterRead(opts, [node], readCtx());
      return visible;
    },

    async searchNodes(options): Promise<MemoryNode[]> {
      return filterRead(opts, await inner.searchNodes(options), readCtx());
    },

    // Enumeration is a read: without this, listNodes on a governed handle would
    // hand back every Sensitive and Sealed fact the policies exist to hide.
    async listNodes(): Promise<MemoryNode[]> {
      return filterRead(opts, await inner.listNodes(), readCtx());
    },
  };

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in governed) return governed[prop as keyof MemoryStore];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as MemoryStore;
}

/** A read-only view whose purpose is "export": beforeExport decides what leaves. Feed it to exportPortable. */
export function exportView(inner: MemoryStore, opts: GovernOptions): MemoryStore {
  return govern(inner, { ...opts, readAs: "export" });
}
