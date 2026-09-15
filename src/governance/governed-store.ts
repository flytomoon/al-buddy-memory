/**
 * govern(store, …) — the same MemoryStore, with policies in front of every
 * write, update and read, and an audit event for each. Anything the wrapper
 * does not govern (edges, embeddings, restore) passes straight through.
 */
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";
import { AUDIT_ID_SAMPLE, type AuditSink } from "./audit.js";
import { PolicyDenied, type GovernancePolicy, type PolicyContext, type Purpose } from "./policy.js";

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

async function filterRead(opts: GovernOptions, nodes: MemoryNode[], ctx: PolicyContext): Promise<MemoryNode[]> {
  const out: MemoryNode[] = [];
  const hidden: string[] = [];
  for (const node of nodes) {
    let current: MemoryNode | null = node;
    for (const p of opts.policies) {
      if (current === null) break;
      if (ctx.purpose === "export" && p.beforeExport) {
        if (!(await p.beforeExport(current, ctx))) current = null;
      } else if (p.beforeRead) {
        current = await p.beforeRead(current, ctx);
      }
    }
    if (current === null) hidden.push(node.nodeId);
    else out.push(current);
  }
  if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
  await record(opts, ctx, "allowed", out.map((n) => n.nodeId));
  return out;
}

export function govern(inner: MemoryStore, opts: GovernOptions): MemoryStore {
  const governed: Partial<MemoryStore> = {
    async addNode(node: NewMemoryNode): Promise<MemoryNode> {
      const ctx = ctxFor(opts, "write");
      let current = node;
      try {
        for (const p of opts.policies) if (p.beforeWrite) current = await p.beforeWrite(current, ctx);
      } catch (err) {
        if (err instanceof PolicyDenied) await record(opts, ctx, "denied", [], { policy: err.policy, reason: err.reason });
        throw err;
      }
      const saved = await inner.addNode(current);
      await record(opts, ctx, "allowed", [saved.nodeId]);
      return saved;
    },
    async updateNode(nodeId, patch, anchorEvent): Promise<MemoryNode> {
      const purpose: Purpose = patch.validTo !== undefined ? "invalidate" : "write";
      const ctx = ctxFor(opts, purpose);
      const existing = await inner.getNode(nodeId);
      if (!existing) throw new Error(`Memory node not found: ${nodeId}`);
      try {
        for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, patch, ctx);
      } catch (err) {
        if (err instanceof PolicyDenied) await record(opts, ctx, "denied", [nodeId], { policy: err.policy, reason: err.reason });
        throw err;
      }
      const updated = anchorEvent === undefined ? await inner.updateNode(nodeId, patch) : await inner.updateNode(nodeId, patch, anchorEvent);
      await record(opts, ctx, "allowed", [nodeId]);
      return updated;
    },
    async getNode(nodeId: string): Promise<MemoryNode | undefined> {
      const node = await inner.getNode(nodeId);
      if (!node) return undefined;
      const [visible] = await filterRead(opts, [node], ctxFor(opts, opts.readAs ?? "recall"));
      return visible;
    },
    async searchNodes(options): Promise<MemoryNode[]> {
      return filterRead(opts, await inner.searchNodes(options), ctxFor(opts, opts.readAs ?? "recall"));
    },
    // Enumeration is a read: without this, listNodes on a governed handle would
    // hand back every Sensitive and Sealed fact the policies exist to hide.
    async listNodes(): Promise<MemoryNode[]> {
      return filterRead(opts, await inner.listNodes(), ctxFor(opts, opts.readAs ?? "recall"));
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
