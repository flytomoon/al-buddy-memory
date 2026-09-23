/**
 * Recently deleted — an allowed erase that waits, and can be taken back
 * (opt-in: `govern(inner, { recentlyDeleted: { days } })`). Moved out of
 * governed-store.ts on 2026-09-22, when binning started to carry a fact's
 * conclusions with it: the file was past its size budget, and this is the part
 * with its own vocabulary. It receives the governed handle's machinery rather
 * than reaching for it, so it can never skip the queue, the policies or the audit.
 */
import { RETENTION_TIERS, type MemoryNode, type MemoryStore } from "../types/memory.js";
import { closureOf, judgeErase } from "./cascade.js";
import { PolicyDenied, type NodePatch, type PolicyContext, type Purpose } from "./policy.js";

/** The contextualMetadata key a pending deletion is recorded under. */
export const DELETION_REQUEST = "deletionRequested";

/** What `listDeleted` returns for each fact waiting in Recently deleted. */
export interface DeletedFact {
  node: MemoryNode;
  /** null when the fact was put in PendingDeletion by some other path, with no recorded request. */
  requestedAt: string | null;
  /** null for the same reason: such a fact is never made final automatically. */
  finalAfter: string | null;
  /** Set on a conclusion binned with the fact it rests on: that fact's id. It comes back, and goes, with it. */
  with?: string;
}

/** The governed handle's extra methods when `recentlyDeleted` is set. */
export interface RecentlyDeletedCapable {
  listDeleted(): Promise<DeletedFact[]>;
  restoreDeleted(nodeId: string): Promise<MemoryNode>;
  /**
   * Erase, for good, every fact whose days are up (or only `nodeIds`;
   * `immediately` skips the wait for those). Each erasure is asked of the erase
   * policies again; a refusal leaves the fact where it is and is reported.
   */
  purgeDeleted(options?: { nodeIds?: string[]; immediately?: boolean }): Promise<{ purged: string[]; waiting: string[]; refused: string[] }>;
}

export function isRecentlyDeletedCapable(store: unknown): store is RecentlyDeletedCapable {
  if (store === null || typeof store !== "object") return false;
  const s = store as Partial<RecentlyDeletedCapable>;
  return typeof s.listDeleted === "function" && typeof s.restoreDeleted === "function" && typeof s.purgeDeleted === "function";
}

export interface DeletionRequest { at: string | null; from: MemoryNode["retentionTier"]; with?: string }

/**
 * The request behind a PendingDeletion fact. A fact put in that tier some other
 * way has no recorded moment (`at: null`), and a clock that was never started
 * never runs out: it waits until someone purges it by id, `immediately`.
 */
export function deletionRequest(node: MemoryNode): DeletionRequest | null {
  if (node.retentionTier !== "PendingDeletion") return null;
  const raw = node.contextualMetadata[DELETION_REQUEST] as Partial<DeletionRequest> | undefined;
  // An unknown tier would make the fact unrestorable (the vocabulary check
  // refuses it), so anything that is not a real tier comes back as FullRetention.
  const from = typeof raw?.from === "string" && (RETENTION_TIERS as readonly string[]).includes(raw.from) && raw.from !== "PendingDeletion" ? raw.from : "FullRetention";
  const at = typeof raw?.at === "string" && Number.isFinite(Date.parse(raw.at)) ? raw.at : null;
  return typeof raw?.with === "string" && raw.with !== "" ? { at, from, with: raw.with } : { at, from };
}

export const DAY_MS = 86_400_000;

/** What the governed handle lends Recently deleted: its queue, checks, audit and views. */
export interface RecentlyDeletedDeps {
  inner: MemoryStore;
  grace: { days: number };
  authorise(purpose: Purpose): () => PolicyContext;
  serialise<T>(step: () => Promise<T>): Promise<T>;
  assertAuditUsable(): void;
  visibleOrNotFound(nodeId: string, ctx: PolicyContext): Promise<{ node: MemoryNode; seen: MemoryNode }>;
  guarded<T>(ctx: PolicyContext, ids: string[], step: () => Promise<T>): Promise<T>;
  commit<T>(ctx: PolicyContext, mutate: () => Promise<T>, describe: (result: T) => { ids: string[]; reason?: string }): Promise<T>;
  view(node: MemoryNode, ctx: PolicyContext): Promise<MemoryNode | null>;
  filterRead(nodes: MemoryNode[], ctx: PolicyContext): Promise<MemoryNode[]>;
  readCtx(): PolicyContext;
  updatePolicies(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): Promise<void>;
  erasePolicies(subject: { node: MemoryNode }, ctx: PolicyContext): Promise<void>;
}

export function recentlyDeletedMethods(d: RecentlyDeletedDeps): RecentlyDeletedCapable {
  const finalAfter = (r: DeletionRequest): string | null => (r.at === null ? null : new Date(Date.parse(r.at) + d.grace.days * DAY_MS).toISOString());
  return {
    listDeleted: async (): Promise<DeletedFact[]> => {
      const pending = (await d.inner.listNodes()).filter((n) => n.retentionTier === "PendingDeletion");
      const visible = await d.filterRead(pending, d.readCtx());
      const byId = new Map(pending.map((n) => [n.nodeId, n]));
      return visible.map((node) => {
        const request = deletionRequest(byId.get(node.nodeId) ?? node)!;
        const fact: DeletedFact = { node, requestedAt: request.at, finalAfter: finalAfter(request) };
        if (request.with !== undefined) fact.with = request.with;
        return fact;
      });
    },

    restoreDeleted: async (nodeId: string): Promise<MemoryNode> => {
      const authorised = d.authorise("write");
      return d.serialise(async () => {
        d.assertAuditUsable();
        const ctx = authorised();
        const { node: existing, seen } = await d.visibleOrNotFound(nodeId, ctx);
        const request = deletionRequest(existing);
        if (request === null) throw new Error(`Memory node ${nodeId} is not in Recently deleted`);
        const restsOn = request.with === undefined ? undefined : await d.inner.getNode(request.with);
        if (restsOn !== undefined && deletionRequest(restsOn) !== null) {
          throw new Error(`Memory node ${nodeId} was concluded from ${request.with}, which is in Recently deleted: restore ${request.with} and it comes back with it`);
        }
        const { [DELETION_REQUEST]: _dropped, ...metadata } = existing.contextualMetadata;
        const patch = { retentionTier: request.from, contextualMetadata: metadata };
        // The conclusions binned with it come back with it.
        const companions = (await d.inner.listNodes()).filter((n) => deletionRequest(n)?.with === nodeId);
        const companionPatch = (n: MemoryNode): NodePatch => {
          const { [DELETION_REQUEST]: _r, ...rest } = n.contextualMetadata;
          return { retentionTier: deletionRequest(n)!.from, contextualMetadata: rest };
        };
        await d.guarded(ctx, [nodeId], async () => {
          await d.updatePolicies(existing, patch, ctx);
          for (const n of companions) await d.updatePolicies(n, companionPatch(n), ctx);
        });
        d.assertAuditUsable();
        const restored = await d.commit(
          ctx,
          async () => {
            const back = await d.inner.updateNode(nodeId, patch);
            for (const n of companions) await d.inner.updateNode(n.nodeId, companionPatch(n));
            return back;
          },
          () => ({ ids: [nodeId, ...companions.map((n) => n.nodeId)], reason: "restored from Recently deleted" }),
        );
        // Unlike updateNode's fallback, `patch` is not the caller's own input: its
        // metadata is the stored, unredacted copy. So the fallback is what they
        // could already see, minus the request, at the restored tier — never
        // the patch's metadata (review 2026-09-22).
        const { [DELETION_REQUEST]: _seenRequest, ...seenMetadata } = seen.contextualMetadata;
        return (
          (await d.view(restored, { ...ctx, purpose: "recall" })) ?? {
            ...seen,
            retentionTier: patch.retentionTier,
            contextualMetadata: seenMetadata,
            temporalAnchors: restored.temporalAnchors,
          }
        );
      });
    },

    purgeDeleted: async (options = {}) => {
      const authorised = d.authorise("erase");
      return d.serialise(async () => {
        d.assertAuditUsable();
        const ctx = authorised();
        const only = options.nodeIds === undefined ? null : new Set(options.nodeIds);
        const purged: string[] = [];
        const waiting: string[] = [];
        const refused: string[] = [];
        const everything = await d.inner.listNodes();
        const binned = new Set(everything.filter((n) => deletionRequest(n) !== null).map((n) => n.nodeId));
        for (const node of everything) {
          const request = deletionRequest(node);
          if (request === null || (only !== null && !only.has(node.nodeId))) continue;
          // A conclusion binned with its fact is made final with that fact, never on its own.
          if (request.with !== undefined && binned.has(request.with)) continue;
          if ((await d.inner.getNode(node.nodeId)) === undefined) continue; // already gone with a fact purged above
          // A fact this actor cannot read is not theirs to erase, and not theirs to learn about.
          if (!(await d.view(node, { ...ctx, purpose: "recall" }))) continue;
          const final = finalAfter(request);
          const due = (only !== null && options.immediately === true) || (final !== null && Date.parse(final) <= ctx.now.getTime());
          if (!due) { waiting.push(node.nodeId); continue; }
          const closure = await closureOf(d.inner, node.nodeId);
          try {
            await d.guarded(ctx, [node.nodeId], () => judgeErase(node, closure, ctx, d.erasePolicies));
          } catch (err) {
            if (err instanceof PolicyDenied) { refused.push(node.nodeId); continue; }
            throw err;
          }
          d.assertAuditUsable();
          await d.commit(ctx, () => d.inner.deleteNode(node.nodeId), () => ({ ids: [node.nodeId, ...closure.map((n) => n.nodeId)], reason: "Recently deleted: made final" }));
          purged.push(node.nodeId);
        }
        return { purged, waiting, refused };
      });
    },
  };
}
