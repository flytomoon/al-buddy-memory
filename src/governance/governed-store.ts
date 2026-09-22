/**
 * govern(store, …) — the same MemoryStore, with policies in front of every
 * operation that can change a fact or reveal one, and an audit event for each.
 *
 * The capability model: hand callers the governed handle and keep the inner
 * store to yourself. A caller holding the inner store is not governed by
 * anything — that is what "the raw store" means.
 *
 * Governed: every MemoryStore method. Writes, updates, imports and erasures run
 * their policies; reads, edges and the embedding cache only ever show or touch
 * facts the actor can see — and a fact they cannot see fails exactly like one
 * that does not exist. Until 2026-09-14 edges, restore and delete passed
 * through, and a stranger could erase a guardian's fact with no audit; until
 * the re-review the embedding cache did, and it confirmed which hidden ids exist.
 */
import { compareRecency, effectiveConfidence } from "../decay.js";
import { queryTokens, visibleRelevance } from "../query-filter.js";
import { buildSnapshotAsOf, canonicalJson, isHistoryCapable, nodeAsOf } from "../history.js";
import { RETENTION_TIERS } from "../types/memory.js";
import type { AsOfFact, AsOfOptions, HistoryCapable, MemoryEdge, MemoryEmbedding, MemoryNode, MemoryStore, NewMemoryNode, NodeVersion } from "../types/memory.js";
import { AUDIT_ID_SAMPLE, StoreAudit, type AuditCapable, type AuditEvent, type AuditSink } from "./audit.js";
import { PolicyDenied, type ErasureSubject, type GovernancePolicy, type NodePatch, type PolicyContext, type Purpose } from "./policy.js";

export interface GovernOptions {
  policies: GovernancePolicy[];
  /** Who is acting right now. Called per operation, so one governed store can serve many actors. */
  context: (purpose: Purpose) => Omit<PolicyContext, "purpose" | "now"> & { now?: Date };
  audit?: AuditSink | undefined;
  /** What a read counts as. exportView sets "export" so beforeExport decides instead of beforeRead. */
  readAs?: "recall" | "export" | undefined;
  /**
   * "Recently deleted". When set, `deleteNode` on this handle does not destroy a
   * fact: after the erase policies allow it, the fact moves to the
   * PendingDeletion tier, out of recall, and stays there for `days`.
   * `restoreDeleted` brings it back; `purgeDeleted` makes erasure final once the
   * days have passed (the erase policies are asked again at that moment, so a
   * memory lock installed since still stops it). Off by default: without it,
   * `deleteNode` erases at once, exactly as before. Links (`deleteEdge`) are
   * still erased at once either way.
   */
  recentlyDeleted?: { days: number } | undefined;
}

/** The contextualMetadata key a pending deletion is recorded under. */
export const DELETION_REQUEST = "deletionRequested";

/** What `listDeleted` returns for each fact waiting in Recently deleted. */
export interface DeletedFact {
  node: MemoryNode;
  /** null when the fact was put in PendingDeletion by some other path, with no recorded request. */
  requestedAt: string | null;
  /** null for the same reason: such a fact is never made final automatically. */
  finalAfter: string | null;
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

interface DeletionRequest { at: string | null; from: MemoryNode["retentionTier"] }

/**
 * The request behind a PendingDeletion fact. A fact put in that tier some other
 * way has no recorded moment (`at: null`), and a clock that was never started
 * never runs out: it waits until someone purges it by id, `immediately`.
 */
function deletionRequest(node: MemoryNode): DeletionRequest | null {
  if (node.retentionTier !== "PendingDeletion") return null;
  const raw = node.contextualMetadata[DELETION_REQUEST] as Partial<DeletionRequest> | undefined;
  // An unknown tier would make the fact unrestorable (the vocabulary check
  // refuses it), so anything that is not a real tier comes back as FullRetention.
  const from = typeof raw?.from === "string" && (RETENTION_TIERS as readonly string[]).includes(raw.from) && raw.from !== "PendingDeletion" ? raw.from : "FullRetention";
  const at = typeof raw?.at === "string" && Number.isFinite(Date.parse(raw.at)) ? raw.at : null;
  return { at, from };
}

const DAY_MS = 86_400_000;

/**
 * Whether a write would put a fact into Recently deleted, take it out, or
 * change its deletion record. That record decides when a purge erases the
 * fact, so writing it is part of erasing: an actor with update rights but no
 * erase rights used to move a fact into PendingDeletion with a backdated
 * request, and the owner's next purge erased it at once (release review
 * 2026-09-21). On every governed handle, with or without `recentlyDeleted`,
 * such a write is judged by the erase policies too. `deleteNode` and
 * `restoreDeleted` are the ways in and out, and they write the record themselves.
 */
function touchesDeletion(
  before: Pick<MemoryNode, "retentionTier" | "contextualMetadata"> | undefined,
  after: Pick<MemoryNode, "retentionTier" | "contextualMetadata">,
): boolean {
  if ((before?.retentionTier === "PendingDeletion") !== (after.retentionTier === "PendingDeletion")) return true;
  return canonicalJson(before?.contextualMetadata?.[DELETION_REQUEST] ?? null) !== canonicalJson(after.contextualMetadata?.[DELETION_REQUEST] ?? null);
}

function ctxFor(opts: GovernOptions, purpose: Purpose): PolicyContext {
  const c = opts.context(purpose);
  return { actor: c.actor, audience: c.audience, purpose, now: c.now ?? new Date() };
}

/**
 * WHO, decided when the call is made. WHEN, read when the work runs.
 *
 * `context` is documented as called per operation "so one governed store can
 * serve many actors", and an application that serves many actors sets it from
 * whoever is being served right now. Queueing the mutations (see `serialise`)
 * moved the `context()` call inside the queued step, so a mutation asked for by
 * one actor ran under whoever the context named by the time the queue reached
 * it: a stranger's refused update committed — and audited — as the owner, and
 * one promise hop was enough to do it. That is a worse failure than the race it
 * was added to fix, and it was found in the merged result (GPT-6-Astra,
 * 2026-09-19; `src/governance/governed-race.test.ts`).
 *
 * The clock deliberately stays late: an event must carry the instant the change
 * actually landed, not the instant a caller joined the queue. A context that
 * pins its own `now` is honoured as given.
 */
function authorise(opts: GovernOptions, purpose: Purpose): () => PolicyContext {
  const c = opts.context(purpose);
  return () => ({ actor: c.actor, audience: c.audience, purpose, now: c.now ?? new Date() });
}

/**
 * A sink that has failed once cannot be trusted to record what happens next, so
 * nothing more is changed through it. Keyed by sink, not by handle: every
 * governed store writing to the same trail stops together.
 *
 * The window this does NOT close is the documented one — a mutation commits and
 * then its event is written, so the write that broke the sink is itself
 * unrecorded (docs/policies/ENFORCEMENT.md). What used to happen after that is
 * the defect: every later write went through as well, each one rejecting, so a
 * retrying client compounded changes nothing could attest to (R3, release
 * review 2026-09-18).
 *
 * "That one write" is a bound, not a typical case, and it is the QUEUE that
 * makes it one: a latch can only refuse a call that has not started, so every
 * mutation goes through `serialise` — `addNode` included, which it was not
 * until 2026-09-19.
 *
 * None of this applies to the store's own `audit_events` table, and that is the
 * point of it: there the event is appended inside the mutation's transaction,
 * so an append that fails rolls the fact back with it. There is no unrecorded
 * write to protect against, so that path deliberately does NOT latch — a
 * transient failure would otherwise brick a store that lost nothing. It is not
 * a regression of the latch; it is the failure the latch bounds becoming
 * unreachable. The latch stays for every sink that writes beside the database,
 * which is every sink a store without the capability can use.
 *
 * "That path" means EVERY event on it, not only a mutation's. This paragraph
 * was written as though mutations were the only kind, and for a day they were
 * the only kind exempted: a read's or a refusal's event still went through
 * `record` below, which latched whatever sink it was handed. So a disk-full
 * during a governed SEARCH bricked a store that had lost nothing, while four
 * places in the docs said that could not happen (Fable 5.1, reviewing the
 * merge, 2026-09-19, reproduced with a real SQLITE_FULL). A read changes
 * nothing and a refusal refuses, so neither can leave an unrecorded write
 * either — the exemption is a property of the sink, and `selfCommitting`
 * carries it.
 */
const POISONED_AUDIT = new WeakMap<AuditSink, Error>();

/** Refuse before touching the store if this trail is already broken. */
function assertAuditUsable(opts: GovernOptions): void {
  const failed = opts.audit ? POISONED_AUDIT.get(opts.audit) : undefined;
  if (failed) throw failed;
}

function auditEvent(ctx: PolicyContext, outcome: "allowed" | "denied" | "hidden", ids: string[], extra: { policy?: string; reason?: string } = {}): AuditEvent {
  return { at: ctx.now.toISOString(), actor: ctx.actor, audience: ctx.audience, purpose: ctx.purpose, outcome, nodeIds: ids.slice(0, AUDIT_ID_SAMPLE), count: ids.length, policy: extra.policy, reason: extra.reason };
}

/**
 * The store's own `audit_events` table, when the caller asked for it AND it
 * belongs to the store being governed. Both halves matter: a `StoreAudit` built
 * over a DIFFERENT store is a sink like any other and must not be handed this
 * store's mutations to commit.
 */
function auditTableFor(opts: GovernOptions, inner: MemoryStore): AuditCapable | null {
  return opts.audit instanceof StoreAudit && (opts.audit.store as unknown) === (inner as unknown) ? opts.audit.store : null;
}

/**
 * The caller's options plus the one fact every helper below needs and none of
 * them can work out: whether this handle's sink is the governed store's OWN
 * table. That takes `inner`, which only `govern` has, so it is resolved once
 * where both are in scope and carried.
 *
 * It decides whether a failed event may latch the store — see `record`.
 */
type ActiveOptions = GovernOptions & { readonly selfCommitting: boolean };

function activate(inner: MemoryStore, opts: GovernOptions): ActiveOptions {
  return { ...opts, selfCommitting: auditTableFor(opts, inner) !== null };
}

/**
 * A mutation and the "allowed" event that attests to it.
 *
 * With the store's own table as the sink, both are ONE transaction: the event
 * is appended inside the store's own `BEGIN IMMEDIATE`, so the fact and the
 * event land together or neither does, and the window below does not exist.
 *
 * With any other sink the store commits and the event is written after it —
 * the documented window (`docs/policies/ENFORCEMENT.md`), bounded to one write
 * by the latch and the queue.
 */
async function commitAudited<T>(
  opts: ActiveOptions,
  inner: MemoryStore,
  ctx: PolicyContext,
  mutate: () => Promise<T>,
  describe: (result: T) => { ids: string[]; reason?: string },
): Promise<T> {
  const table = auditTableFor(opts, inner);
  if (table !== null) {
    return table.auditedMutation(mutate, (result) => {
      const { ids, reason } = describe(result);
      return auditEvent(ctx, "allowed", ids, reason === undefined ? {} : { reason });
    });
  }
  const result = await mutate();
  const { ids, reason } = describe(result);
  await record(opts, ctx, "allowed", ids, reason === undefined ? {} : { reason });
  return result;
}

async function record(opts: ActiveOptions, ctx: PolicyContext, outcome: "allowed" | "denied" | "hidden", ids: string[], extra: { policy?: string; reason?: string } = {}): Promise<void> {
  if (!opts.audit) return;
  try {
    await opts.audit.record(auditEvent(ctx, outcome, ids, extra));
  } catch (err) {
    // Reads and refusals come through here too, and on the store's own table
    // neither can leave an unrecorded write: a read changes nothing, a refusal
    // refuses, and a mutation's event is inside the mutation's transaction. The
    // latch exists to bound unrecorded writes, so with none possible it would
    // only brick a store that lost nothing — which is what a disk-full during a
    // governed SEARCH used to do (Fable 5.1, reviewing the merge, 2026-09-19).
    // The error still propagates; it is the caller's problem, not the store's.
    if (opts.audit && !opts.selfCommitting && !POISONED_AUDIT.has(opts.audit)) {
      POISONED_AUDIT.set(
        opts.audit,
        new Error(`the audit sink failed (${err instanceof Error ? err.message : String(err)}); this store is not changing anything more until the log is checked with \`al-buddy-memory verify-audit\` and the process restarts`),
      );
    }
    throw err;
  }
}

/**
 * Authorisation and the mutation it authorises, run as one step.
 *
 * The checks await — policy hooks are async by design — so between "this actor
 * may change this fact" and the write itself, another handle over the same
 * store could change the fact out from under the decision. An agent's allowed
 * update landed after the owner had made the fact Sensitive and left it Private
 * and readable (R2, release review 2026-09-18).
 *
 * The queue is keyed on the INNER store, so every governed handle over one
 * store shares it; a per-handle lock would have missed the reported case
 * exactly. Reads are not queued: they take no decision they then act on.
 *
 * Two limits, stated rather than implied. This is one process — two processes
 * on one SQLite file are still only protected by SQLite's own write lock, which
 * covers the write and not the decision. And a policy hook must not call a
 * mutating method on a governed store over the same inner store: it would be
 * waiting for the queue it is already holding.
 */
const MUTATIONS = new WeakMap<object, Promise<unknown>>();

function serialise<T>(inner: object, step: () => Promise<T>): Promise<T> {
  const queued = MUTATIONS.get(inner) ?? Promise.resolve();
  // `step` runs whether the one before it resolved or rejected: a refusal must
  // not jam the queue for everyone after it.
  const next = queued.then(step, step);
  MUTATIONS.set(inner, next.then(() => undefined, () => undefined));
  return next;
}

/** One fact as this actor would see it on a read: the node (possibly redacted), or null. No audit. */
async function view(opts: ActiveOptions, node: MemoryNode, ctx: PolicyContext): Promise<MemoryNode | null> {
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

async function filterRead(opts: ActiveOptions, nodes: MemoryNode[], ctx: PolicyContext): Promise<MemoryNode[]> {
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

/**
 * The facts whose HISTORY this actor may read: visible today and passed through
 * the read policies unchanged. Access is decided on the current fact, never on a
 * past image. And a policy that redacts a fact on read was written for its
 * present form: the before/after images in its history carry the very fields it
 * strips, and no rule can redact a past it never sees. So a redacted fact's
 * history is withheld (fail closed), audited as a hidden read.
 */
async function historyReadable(opts: ActiveOptions, nodes: MemoryNode[], ctx: PolicyContext): Promise<Set<string>> {
  const readable = new Set<string>();
  const hidden: string[] = [];
  for (const node of nodes) {
    const seen = await view(opts, node, ctx);
    if (seen !== null && canonicalJson(seen) === canonicalJson(node)) readable.add(node.nodeId);
    else hidden.push(node.nodeId);
  }
  if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
  await record(opts, ctx, "allowed", [...readable]);
  return readable;
}

/** Run a policy step; a refusal is audited, then rethrown. */
async function guarded<T>(opts: ActiveOptions, ctx: PolicyContext, ids: string[], step: () => Promise<T>): Promise<T> {
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

/**
 * Copy an argument the moment a governed call is made. The checks await; a caller
 * in the same process that still holds the object could otherwise pass a visible
 * id, clear the check, and swap in a hidden one before the write (Astra final
 * review, 2026-09-15). Everything after this line sees only the copy.
 */
const snapshot = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));
// JSON, not structuredClone: facts, edges and embeddings are persisted as JSON, so
// this is exactly what the store would keep — functions dropped, toJSON honoured,
// Buffers as SQLite writes them. structuredClone threw on a function in metadata
// and changed how class instances and Buffers came out (Astra confirmation).
// Search options are copied field by field instead, because JSON turns an
// Infinity limit into null.
const snapshotOptions = <T extends object>(options: T): T =>
  Object.fromEntries(Object.entries(options).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])) as T;

export function govern<T extends MemoryStore>(inner: T, options: GovernOptions): T extends HistoryCapable ? MemoryStore & HistoryCapable : MemoryStore;
export function govern(inner: MemoryStore, options: GovernOptions): MemoryStore {
  // Resolved once, here, because it is the only place `inner` and the sink are
  // both in scope; everything below reads it off `opts`.
  const opts = activate(inner, options);
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

  // A plain object holding exactly the MemoryStore methods — typed as the full
  // interface so a new store method cannot be forgotten here. It used to be a
  // Proxy over the inner store that forwarded every other property, so
  // `governed.db` (SQLite) and `governed.nodes` (in-memory) handed a stranger
  // the raw data (Fable re-review, 2026-09-15). Whoever should close or tune the
  // store holds the inner one.
  const governed: MemoryStore & Partial<HistoryCapable> = {
    async addNode(input: NewMemoryNode): Promise<MemoryNode> {
      const node = snapshot(input);
      const authorised = authorise(opts, "write");
      // Queued like every other mutation. A brand-new fact answers no earlier
      // question, so this is not about the R2 race — it is the audit latch.
      // The latch refuses calls that have not STARTED, so twenty concurrent
      // adds all cleared the check before the first failure was observed:
      // twenty rejected callers, twenty facts in the store, no events, against
      // a bound of one written down in `docs/policies/ENFORCEMENT.md`
      // (GPT-6-Astra on the merged result, 2026-09-19). The queue is what makes
      // that bound true rather than typical.
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const current = await guarded(opts, ctx, [], () => writePolicies(node, ctx));
        if (touchesDeletion(undefined, current)) {
          const provisional = { ...current, nodeId: "", temporalAnchors: [], validFrom: current.validFrom ?? ctx.now.toISOString(), validTo: current.validTo ?? null } as MemoryNode;
          await guarded(opts, ctx, [], () => erasePolicies({ node: provisional }, ctx));
        }
        assertAuditUsable(opts);
        return commitAudited(opts, inner, ctx, () => inner.addNode(current), (saved) => ({ ids: [saved.nodeId] }));
      });
    },

    async updateNode(nodeId, input, anchorEvent): Promise<MemoryNode> {
      const patch = snapshot(input);
      const authorised = authorise(opts, patch.validTo !== undefined ? "invalidate" : "write");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        // A fact this actor cannot read is a fact this actor cannot change, and
        // its text must not come back in the response. This used to fetch the
        // node unfiltered, so `updateNode(secretId, {})` returned the secret and
        // `{ privacyClassification: "Private" }` made it readable for good.
        const { node: existing, seen } = await visibleOrNotFound(nodeId, ctx);
        await guarded(opts, ctx, [nodeId], async () => {
          for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, patch, ctx);
          if (touchesDeletion(existing, { ...existing, ...patch })) await erasePolicies({ node: existing }, ctx);
        });
        assertAuditUsable(opts);
        const updated = await commitAudited(
          opts,
          inner,
          ctx,
          () => (anchorEvent === undefined ? inner.updateNode(nodeId, patch) : inner.updateNode(nodeId, patch, anchorEvent)),
          () => ({ ids: [nodeId] }),
        );
        // What they could already see, plus what they themselves wrote. Safe to
        // fall back on `seen` only because nothing else could commit between
        // the read and this line — see `serialise`.
        return (await view(opts, updated, { ...ctx, purpose: "recall" })) ?? { ...seen, ...patch, temporalAnchors: updated.temporalAnchors };
      });
    },

    async restoreNode(input: MemoryNode): Promise<void> {
      const node = snapshot(input);
      const authorised = authorise(opts, "import");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const existing = await inner.getNode(node.nodeId);
        let incoming = node;
        await guarded(opts, ctx, [node.nodeId], async () => {
          // The write policies run FIRST: they authorise the import before anything
          // depends on whether the fact already exists, so a refused actor learns
          // nothing about which ids are there (Astra final review, 2026-09-15). They
          // also see an import exactly as they see a new fact, so a restored secret is
          // classified the same way a written one is...
          const { nodeId, temporalAnchors, validFrom, validTo, ...fields } = node;
          const written = await writePolicies({ ...fields, validFrom, validTo }, ctx);
          incoming = { ...node, ...written, nodeId, temporalAnchors };
          if (existing && !(await view(opts, existing, { ...ctx, purpose: "recall" }))) {
            throw new PolicyDenied("govern", "cannot restore over a fact this actor cannot read");
          }
          // ...and the update policies judge what will actually be stored, not the
          // copy before the write policies shaped it (Astra re-review, 2026-09-15:
          // a write policy that archived on import slipped past an update policy
          // that forbade archiving).
          if (existing) for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, asPatch(incoming), ctx);
          if (touchesDeletion(existing, incoming)) await erasePolicies({ node: existing ?? incoming }, ctx);
        });
        assertAuditUsable(opts);
        await commitAudited(opts, inner, ctx, () => inner.restoreNode(incoming), () => ({ ids: [node.nodeId] }));
      });
    },

    async deleteNode(nodeId: string): Promise<void> {
      const authorised = authorise(opts, "erase");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const { node } = await visibleOrNotFound(nodeId, ctx);
        await guarded(opts, ctx, [nodeId], () => erasePolicies({ node }, ctx));
        assertAuditUsable(opts);
        const grace = opts.recentlyDeleted;
        if (grace === undefined) {
          await commitAudited(opts, inner, ctx, () => inner.deleteNode(nodeId), () => ({ ids: [nodeId] }));
          return;
        }
        // Already waiting: a second delete is not "delete harder". It keeps the
        // first request and its clock; purgeDeleted is the way to make it final.
        // It is still an erase request that was allowed, so it is recorded.
        const pending = deletionRequest(node);
        if (pending !== null && pending.at !== null) {
          await record(opts, ctx, "allowed", [nodeId], { reason: "already in Recently deleted; the first request's clock stands" });
          return;
        }
        // In PendingDeletion with no recorded request (put there some other way):
        // this request starts the clock, instead of leaving it waiting for ever.
        const request: DeletionRequest = { at: ctx.now.toISOString(), from: pending?.from ?? node.retentionTier };
        await commitAudited(
          opts,
          inner,
          ctx,
          () => inner.updateNode(nodeId, { retentionTier: "PendingDeletion", contextualMetadata: { ...node.contextualMetadata, [DELETION_REQUEST]: request } }, "archived"),
          () => ({ ids: [nodeId], reason: `moved to Recently deleted; final after ${grace.days} days` }),
        );
      });
    },

    async deleteEdge(edgeId: string): Promise<void> {
      const authorised = authorise(opts, "erase");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        await guarded(opts, ctx, [], () => erasePolicies({ edgeId }, ctx));
        assertAuditUsable(opts);
        await commitAudited(opts, inner, ctx, () => inner.deleteEdge(edgeId), () => ({ ids: [], reason: `edge ${edgeId}` }));
      });
    },

    async addEdge(input): Promise<MemoryEdge> {
      const edge = snapshot(input);
      const authorised = authorise(opts, "write");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        // Linking to a hidden fact would confirm that its id exists.
        await visibleOrNotFound(edge.sourceNodeId, ctx);
        await visibleOrNotFound(edge.targetNodeId, ctx);
        assertAuditUsable(opts);
        return commitAudited(opts, inner, ctx, () => inner.addEdge(edge), (saved) => ({ ids: [edge.sourceNodeId, edge.targetNodeId], reason: `edge ${saved.edgeId}` }));
      });
    },

    async restoreEdge(input: MemoryEdge): Promise<void> {
      const edge = snapshot(input);
      const authorised = authorise(opts, "import");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        await visibleOrNotFound(edge.sourceNodeId, ctx);
        await visibleOrNotFound(edge.targetNodeId, ctx);
        assertAuditUsable(opts);
        await commitAudited(opts, inner, ctx, () => inner.restoreEdge(edge), () => ({ ids: [edge.sourceNodeId, edge.targetNodeId], reason: `edge ${edge.edgeId}` }));
      });
    },

    async getEdges(nodeId: string): Promise<MemoryEdge[]> {
      const ctx = readCtx();
      if (!(await governed.getNode(nodeId))) return [];
      const out: MemoryEdge[] = [];
      for (const edge of await inner.getEdges(nodeId)) {
        const other = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
        const node = await inner.getNode(other);
        // An edge to a hidden fact discloses the hidden fact's id and relation.
        if (node && (await view(opts, node, ctx))) out.push(edge);
      }
      return out;
    },

    // The embedding cache: vectors are derived from facts, so they follow the
    // facts' visibility. Writing a vector onto a hidden fact succeeded while a
    // missing id failed — an oracle for which hidden ids exist.
    async setEmbedding(input): Promise<MemoryEmbedding> {
      const embedding = snapshot(input);
      const authorised = authorise(opts, "write");
      return serialise(inner, async () => {
        await visibleOrNotFound(embedding.nodeId, authorised());
        return inner.setEmbedding(embedding);
      });
    },
    async getEmbeddings(nodeId: string): Promise<MemoryEmbedding[]> {
      return (await governed.getNode(nodeId)) ? inner.getEmbeddings(nodeId) : [];
    },
    async deleteEmbeddings(nodeId: string, model?: string): Promise<void> {
      const authorised = authorise(opts, "write");
      return serialise(inner, async () => {
        await visibleOrNotFound(nodeId, authorised());
        return model === undefined ? inner.deleteEmbeddings(nodeId) : inner.deleteEmbeddings(nodeId, model);
      });
    },
    async listEmbeddings(model: string): Promise<MemoryEmbedding[]> {
      // One pass over the facts, not one lookup per vector.
      const ctx = readCtx();
      const visible = new Set<string>();
      for (const node of await inner.listNodes()) if (await view(opts, node, ctx)) visible.add(node.nodeId);
      return (await inner.listEmbeddings(model)).filter((e) => visible.has(e.nodeId));
    },

    async getNode(nodeId: string): Promise<MemoryNode | undefined> {
      const node = await inner.getNode(nodeId);
      if (!node) return undefined;
      const [visible] = await filterRead(opts, [node], readCtx());
      return visible;
    },

    async searchNodes(input): Promise<MemoryNode[]> {
      const options = snapshotOptions(input);
      const ctx = readCtx();
      // A cursor this actor cannot see is a missing cursor: the page after it is
      // empty. It used to answer differently for a hidden id than a missing one.
      if (options.after !== undefined) {
        const cursor = await inner.getNode(options.after);
        if (!cursor || !(await view(opts, cursor, ctx))) {
          // The actor sees an empty page either way; the operator's trail records
          // a probe with a hidden id as a hidden read, as getNode does.
          if (cursor) await record(opts, ctx, "hidden", [cursor.nodeId]);
          await record(opts, ctx, "allowed", []);
          return [];
        }
      }
      // Whole facts only: with a fractional limit the page-full check never fired
      // and hidden facts took places again (Fable confirmation, 2026-09-15).
      const limit = options.limit === undefined ? undefined : Math.floor(options.limit);

      // With a query, the store decides WHICH facts match — fact by fact — but its
      // ranking (BM25) weighs words by how rare they are across every fact, hidden
      // ones included, so adding a hidden fact could reorder the visible results
      // and an AI could test what hidden facts contain (Astra final review; founder:
      // "fix it", 2026-09-15). So a governed keyword search reads every match, keeps
      // the visible ones, and ranks them by their own text alone, then effective
      // confidence, then recency. It costs a full read of the matches per query.
      const tokens = options.query === undefined ? [] : queryTokens(options.query);
      if (tokens.length > 0) {
        const { limit: _l, after: _a, ...unpaged } = options;
        const matches = await inner.searchNodes(unpaged);
        const now = Date.now();
        const seenNodes: MemoryNode[] = [];
        const hidden: string[] = [];
        for (const node of matches) {
          const seen = await view(opts, node, ctx);
          if (seen) seenNodes.push(seen);
          else hidden.push(node.nodeId);
        }
        // Scored from the text the actor sees (a redacting policy's view, not the
        // stored words), with word rarity counted over these visible matches only.
        const scores = visibleRelevance(seenNodes.map((n) => n.content.text), tokens);
        const visible = seenNodes.map((node, i) => ({ node, score: scores[i]!, eff: effectiveConfidence(node, now) }));
        visible.sort((a, b) => b.score - a.score || b.eff - a.eff || compareRecency(a.node, b.node));
        let ranked = visible.map((v) => v.node);
        if (options.after !== undefined) {
          const at = ranked.findIndex((n) => n.nodeId === options.after);
          ranked = at < 0 ? [] : ranked.slice(at + 1); // a cursor outside these results has nothing after it
        }
        if (limit !== undefined && Number.isFinite(limit)) ranked = ranked.slice(0, Math.max(0, limit));
        if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
        await record(opts, ctx, "allowed", ranked.map((n) => n.nodeId));
        return ranked;
      }

      if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
        return filterRead(opts, await inner.searchNodes(options), ctx);
      }
      // The page is the first `limit` facts this actor may see. Filtering after
      // the store's limit let hidden facts take the places: as an AI audience,
      // recall("password", limit 1) came back empty while limit 50 found the
      // visible fact, so any word could be probed for secrets that contain it
      // (Fable final review, 2026-09-15). Read further until the page is full
      // of visible facts or the store has no more; the store's limited read is
      // a prefix of its full read, so the result is exact.
      for (let ask = limit; ; ask *= 2) {
        const rows = await inner.searchNodes({ ...options, limit: ask });
        const page: MemoryNode[] = [];
        const hidden: string[] = [];
        for (const node of rows) {
          const seen = await view(opts, node, ctx);
          if (seen) page.push(seen);
          else hidden.push(node.nodeId);
          if (page.length === limit) break;
        }
        if (page.length === limit || rows.length < ask) {
          if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
          await record(opts, ctx, "allowed", page.map((n) => n.nodeId));
          return page;
        }
      }
    },

    // Enumeration is a read: without this, listNodes on a governed handle would
    // hand back every Sensitive and Sealed fact the policies exist to hide.
    async listNodes(): Promise<MemoryNode[]> {
      return filterRead(opts, await inner.listNodes(), readCtx());
    },
  };

  if (isHistoryCapable(inner)) {
    /**
     * A fact and its versions as ONE state, so the fact the policies judge is
     * the fact whose history is served. They used to be read separately, and a
     * fact sealed between the check and the second read leaked through its own
     * history (release review 2026-09-21). No cross-call transaction exists on
     * the interface, so: read the fact, its versions, the fact again, and retry
     * if it moved. Every change appends an anchor, so a fact that reads the same
     * twice did not change in between. Still moving after five tries: withheld.
     */
    const factWithHistory = async (nodeId: string): Promise<{ current: MemoryNode; versions: NodeVersion[] } | null> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await inner.getNode(nodeId);
        if (!current) return null;
        const versions = await inner.history(nodeId);
        const again = await inner.getNode(nodeId);
        // The versions are read twice as well: erasing a fact and re-importing an
        // identical copy between two reads leaves the fact looking the same while
        // its history went with the erasure (release review 2026-09-21).
        const versionsAgain = await inner.history(nodeId);
        if (again && canonicalJson(again) === canonicalJson(current) && canonicalJson(versionsAgain) === canonicalJson(versions)) return { current, versions };
      }
      return null;
    };
    governed.history = async (nodeId: string): Promise<NodeVersion[]> => {
      const read = await factWithHistory(nodeId);
      if (!read) return [];
      const readable = await historyReadable(opts, [read.current], readCtx());
      return readable.has(nodeId) ? read.versions : [];
    };
    governed.getNodeAsOf = async (nodeId: string, asOf: string): Promise<AsOfFact | undefined> => {
      const read = await factWithHistory(nodeId);
      if (!read) return undefined;
      const readable = await historyReadable(opts, [read.current], readCtx());
      if (!readable.has(nodeId)) return undefined;
      const { node, exact } = nodeAsOf(read.current, read.versions, asOf);
      return node === undefined ? undefined : { node, exact };
    };
    governed.historySnapshot = async () => {
      // The export path. A fact the policies let out but redact leaves redacted,
      // exactly as it does today, WITHOUT its versions (see historyReadable).
      const snap = await inner.historySnapshot();
      const ctx = readCtx();
      const nodes: MemoryNode[] = [];
      const hidden: string[] = [];
      const withHistory = new Set<string>();
      for (const node of snap.nodes) {
        const seen = await view(opts, node, ctx);
        if (seen === null) { hidden.push(node.nodeId); continue; }
        nodes.push(seen);
        if (canonicalJson(seen) === canonicalJson(node)) withHistory.add(node.nodeId);
      }
      if (hidden.length > 0) await record(opts, ctx, "hidden", hidden);
      await record(opts, ctx, "allowed", nodes.map((n) => n.nodeId));
      const included = new Set(nodes.map((node) => node.nodeId));
      return {
        nodes,
        edges: snap.edges.filter((edge) => included.has(edge.sourceNodeId) && included.has(edge.targetNodeId)),
        versions: snap.versions.filter((version) => withHistory.has(version.nodeId)),
      };
    };
    governed.snapshotAsOf = async (asOf: string, asOfOptions: AsOfOptions = {}) => {
      const snap = await inner.historySnapshot();
      const included = await historyReadable(opts, snap.nodes, readCtx());
      const versions = new Map<string, NodeVersion[]>();
      for (const version of snap.versions) {
        if (!included.has(version.nodeId)) continue;
        const list = versions.get(version.nodeId) ?? [];
        list.push(version);
        versions.set(version.nodeId, list);
      }
      return buildSnapshotAsOf(
        snap.nodes.filter((node) => included.has(node.nodeId)),
        snap.edges.filter((edge) => included.has(edge.sourceNodeId) && included.has(edge.targetNodeId)),
        versions,
        asOf,
        asOfOptions,
      );
    };
    governed.restoreVersion = async (input: NodeVersion): Promise<void> => {
      const version = snapshot(input);
      const authorised = authorise(opts, "import");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const { node: existing } = await visibleOrNotFound(version.nodeId, ctx);
        // Writing a fact's history is a change to that fact's record, so the
        // update policies judge it as they judge restoreNode over it, and they
        // see the change it records: the state it says the fact moved to. An
        // empty patch let a rule about, say, who may retire a fact wave through
        // a version that retires it (release review 2026-09-21).
        const patch: NodePatch = { ...version.after };
        await guarded(opts, ctx, [version.nodeId], async () => {
          for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, patch, ctx);
        });
        assertAuditUsable(opts);
        await commitAudited(opts, inner, ctx, () => inner.restoreVersion(version), () => ({ ids: [version.nodeId] }));
      });
    };
  }

  const grace = opts.recentlyDeleted;
  if (grace !== undefined) {
    if (!(Number.isFinite(grace.days) && grace.days >= 0)) throw new Error("recentlyDeleted.days must be a number of days, 0 or more");
    const finalAfter = (r: DeletionRequest): string | null => (r.at === null ? null : new Date(Date.parse(r.at) + grace.days * DAY_MS).toISOString());
    const extra = governed as MemoryStore & Partial<RecentlyDeletedCapable>;

    extra.listDeleted = async (): Promise<DeletedFact[]> => {
      const pending = (await inner.listNodes()).filter((n) => n.retentionTier === "PendingDeletion");
      const visible = await filterRead(opts, pending, readCtx());
      const byId = new Map(pending.map((n) => [n.nodeId, n]));
      return visible.map((node) => {
        const request = deletionRequest(byId.get(node.nodeId) ?? node)!;
        return { node, requestedAt: request.at, finalAfter: finalAfter(request) };
      });
    };

    extra.restoreDeleted = async (nodeId: string): Promise<MemoryNode> => {
      const authorised = authorise(opts, "write");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const { node: existing, seen } = await visibleOrNotFound(nodeId, ctx);
        const request = deletionRequest(existing);
        if (request === null) throw new Error(`Memory node ${nodeId} is not in Recently deleted`);
        const { [DELETION_REQUEST]: _dropped, ...metadata } = existing.contextualMetadata;
        const patch = { retentionTier: request.from, contextualMetadata: metadata };
        await guarded(opts, ctx, [nodeId], async () => {
          for (const p of opts.policies) if (p.beforeUpdate) await p.beforeUpdate(existing, patch, ctx);
        });
        assertAuditUsable(opts);
        const restored = await commitAudited(opts, inner, ctx, () => inner.updateNode(nodeId, patch), () => ({ ids: [nodeId], reason: "restored from Recently deleted" }));
        return (await view(opts, restored, { ...ctx, purpose: "recall" })) ?? { ...seen, ...patch, temporalAnchors: restored.temporalAnchors };
      });
    };

    extra.purgeDeleted = async (options = {}) => {
      const authorised = authorise(opts, "erase");
      return serialise(inner, async () => {
        assertAuditUsable(opts);
        const ctx = authorised();
        const only = options.nodeIds === undefined ? null : new Set(options.nodeIds);
        const purged: string[] = [];
        const waiting: string[] = [];
        const refused: string[] = [];
        for (const node of await inner.listNodes()) {
          const request = deletionRequest(node);
          if (request === null || (only !== null && !only.has(node.nodeId))) continue;
          // A fact this actor cannot read is not theirs to erase, and not theirs to learn about.
          if (!(await view(opts, node, { ...ctx, purpose: "recall" }))) continue;
          const final = finalAfter(request);
          const due = (only !== null && options.immediately === true) || (final !== null && Date.parse(final) <= ctx.now.getTime());
          if (!due) { waiting.push(node.nodeId); continue; }
          try {
            await guarded(opts, ctx, [node.nodeId], () => erasePolicies({ node }, ctx));
          } catch (err) {
            if (err instanceof PolicyDenied) { refused.push(node.nodeId); continue; }
            throw err;
          }
          assertAuditUsable(opts);
          await commitAudited(opts, inner, ctx, () => inner.deleteNode(node.nodeId), () => ({ ids: [node.nodeId], reason: "Recently deleted: made final" }));
          purged.push(node.nodeId);
        }
        return { purged, waiting, refused };
      });
    };
  }

  return Object.freeze(governed);
}

/**
 * A read-only view whose purpose is "export": beforeExport decides what leaves.
 * Feed it to exportPortable. Read-only in fact, not just in name — every write
 * method refuses (it deleted, before the final review).
 */
export function exportView<T extends MemoryStore>(inner: T, opts: GovernOptions): T extends HistoryCapable ? MemoryStore & HistoryCapable : MemoryStore;
export function exportView(inner: MemoryStore, opts: GovernOptions): MemoryStore {
  // No Recently deleted on an export view: it is read-only, and purgeDeleted and
  // restoreDeleted are writes (release review 2026-09-21).
  const view = govern(inner, { ...opts, readAs: "export", recentlyDeleted: undefined });
  const refuse = async (): Promise<never> => {
    throw new Error("exportView is read-only");
  };
  return Object.freeze({
    ...view,
    addNode: refuse,
    updateNode: refuse,
    deleteNode: refuse,
    restoreNode: refuse,
    restoreEdge: refuse,
    addEdge: refuse,
    deleteEdge: refuse,
    setEmbedding: refuse,
    deleteEmbeddings: refuse,
    ...(isHistoryCapable(view) ? { restoreVersion: refuse } : {}),
  });
}
