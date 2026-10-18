/**
 * Promotion — sharing a fact with a team or the whole organisation, and taking
 * it back (docs/policies/scopes.md#promotion). On every `govern()` handle:
 *
 * - `promote(sourceId, request)` writes a NEW fact at the target scope holding
 *   the text the person approved, with the source's provenance and author. The
 *   source is untouched: no edit, no edge. One audit event, purpose `promote`,
 *   names both facts; that event is the consent record, and the copy's
 *   `promotion` label is a convenience.
 * - `withdraw(copyId, reason)` closes the copy's `validTo` with a retraction
 *   (`by: "withdrawal"`), purpose `withdraw`. Never deleted.
 * - `verifyPromotion(copyId, trail)` finds the event in a trail that verifies.
 *
 * Who may promote what, where, is the policies' call (`beforePromote`; the
 * `teamMemory` sample holds the rules). What no policy can switch off is here:
 * a fact this actor cannot see is "not found", one they see redacted is not
 * theirs to share, and a Sensitive, Sealed, retired or binned fact is never
 * promoted, because the copy is at most Private and must be true now.
 *
 * Moved out of governed-store.ts for the same reason as Recently deleted: it
 * receives the handle's queue, checks and audit rather than reaching for them,
 * so it cannot skip any of them.
 */
import { canonicalJson } from "../history.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";
import { visitTrail, type AuditEvent, type AuditVerifiable, type AuditVisitor } from "./audit.js";
import { judgeInvalidation } from "./cascade.js";
import { DELETION_REQUEST } from "./recently-deleted.js";
import { PolicyDenied, type GovernancePolicy, type NodePatch, type PolicyContext, type ProcessFields, type PromotionBasis, type PromotionRequest, type Purpose } from "./policy.js";

/** The contextualMetadata key a promoted copy carries its record under. */
export const PROMOTION = "promotion";

export const PROMOTION_BASES: readonly PromotionBasis[] = ["self", "admin-approved", "policy"];

/** What a promoted copy says about itself (`contextualMetadata.promotion`). */
export interface PromotionRecord {
  /** The fact it was promoted from. */
  readonly from: string;
  /** Who promoted it. */
  readonly by: string;
  readonly approvedBy: string | null;
  readonly at: string;
  readonly basis: PromotionBasis;
  /** Whether the approved text differs from the source's. */
  readonly edited: boolean;
  readonly fields?: ProcessFields;
}

/** The governed handle's promotion methods. Present on every `govern()` handle; an export view refuses them. */
export interface PromotionCapable {
  /**
   * Write a copy of a fact this actor can see whole at the scope `request.to`,
   * as the promotion policies allow, audited as one `promote` event naming
   * `[sourceId, copyId]`. Returns the copy's id and that event.
   */
  promote(sourceId: string, request: PromotionRequest): Promise<{ copyId: string; event: AuditEvent }>;
  /** Close a promoted copy's validity, with a retraction saying why. Never deletes. A copy already closed comes back as it is. */
  withdraw(copyId: string, reason: string): Promise<MemoryNode>;
}

export function isPromotionCapable(store: unknown): store is PromotionCapable {
  const s = store as Partial<PromotionCapable> | null;
  return typeof s === "object" && s !== null && typeof s.promote === "function" && typeof s.withdraw === "function";
}

/** A fact's promotion record, or null when it is not a promoted copy. */
export function promotionOf(node: Pick<MemoryNode, "contextualMetadata">): PromotionRecord | null {
  const raw = node.contextualMetadata[PROMOTION] as Partial<PromotionRecord> | undefined;
  if (raw === null || typeof raw !== "object" || typeof raw.from !== "string" || typeof raw.by !== "string" || typeof raw.at !== "string") return null;
  return raw as PromotionRecord;
}

/** Refuse a malformed request before the queue, so nothing is read. Returns the request as the copy will record it. */
export function assertPromotionRequest(sourceId: unknown, request: unknown): PromotionRequest {
  const fail = (why: string): never => {
    throw new Error(`promote: ${why}`);
  };
  if (typeof sourceId !== "string" || sourceId === "") fail("the source must be a fact id");
  if (typeof request !== "object" || request === null || Array.isArray(request)) fail("the request must be an object");
  const r = request as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!["to", "text", "fields", "basis", "approvedBy"].includes(key)) fail(`unknown field ${key}`);
  if (typeof r["to"] !== "string" || r["to"].trim() === "" || r["to"] !== r["to"].trim()) fail("`to` must name one scope (e.g. team:<id> or org)");
  if (!PROMOTION_BASES.includes(r["basis"] as PromotionBasis)) fail(`\`basis\` must be one of ${PROMOTION_BASES.join(", ")}`);
  if (r["text"] !== undefined && (typeof r["text"] !== "string" || r["text"].trim() === "")) fail("`text`, when given, must be the approved text (not empty)");
  if (r["approvedBy"] !== undefined && (typeof r["approvedBy"] !== "string" || r["approvedBy"] === "")) fail("`approvedBy` must be an actor id");
  // The two go together: an approver with no approval basis, or the reverse, records a consent nobody gave.
  if ((r["basis"] === "admin-approved") !== (r["approvedBy"] !== undefined)) fail("`approvedBy` goes with basis admin-approved, and admin-approved needs `approvedBy`");
  const fields = r["fields"];
  if (fields !== undefined) {
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) fail("`fields` must be an object of strings, numbers and booleans");
    for (const [k, v] of Object.entries(fields as object)) {
      if (k === "" || !(typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) fail(`fields.${k} must be a string, a finite number or a boolean`);
    }
  }
  return {
    to: r["to"] as string,
    basis: r["basis"] as PromotionBasis,
    ...(r["text"] === undefined ? {} : { text: r["text"] as string }),
    ...(fields === undefined ? {} : { fields: { ...(fields as ProcessFields) } }),
    ...(r["approvedBy"] === undefined ? {} : { approvedBy: r["approvedBy"] as string }),
  };
}

/** The scopes a fact's `scope` label names (one string or a list); anything else names none. */
const scopesOf = (node: MemoryNode): string[] => {
  const s = node.contextualMetadata["scope"];
  return typeof s === "string" ? [s] : Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
};

/** What the governed handle lends promotion: its queue, checks, audit and views. */
export interface PromotionDeps {
  inner: MemoryStore;
  policies: readonly GovernancePolicy[];
  authorise(purpose: Purpose): () => PolicyContext;
  serialise<T>(step: () => Promise<T>): Promise<T>;
  assertAuditUsable(): void;
  visibleOrNotFound(nodeId: string, ctx: PolicyContext): Promise<{ node: MemoryNode; seen: MemoryNode }>;
  guarded<T>(ctx: PolicyContext, ids: string[], step: () => Promise<T>): Promise<T>;
  commit<T>(ctx: PolicyContext, mutate: () => Promise<T>, describe: (result: T) => { ids: string[]; reason?: string }): Promise<T>;
  /** The "allowed" event `commit` records for these ids and reason. */
  allowedEvent(ctx: PolicyContext, ids: string[], reason: string): AuditEvent;
  view(node: MemoryNode, ctx: PolicyContext): Promise<MemoryNode | null>;
  updatePolicies(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): Promise<void>;
}

export function promotionMethods(d: PromotionDeps): PromotionCapable {
  const deny = (why: string): never => {
    throw new PolicyDenied("govern", why);
  };
  async function promotePolicies(source: MemoryNode, request: PromotionRequest, ctx: PolicyContext): Promise<void> {
    let allowed = false;
    for (const p of d.policies) if (p.beforePromote && (await p.beforePromote(source, request, ctx)) === true) allowed = true;
    if (!allowed) deny("promotion is not enabled: no policy allows it");
  }
  const canSee = (ctx: PolicyContext) => async (node: MemoryNode): Promise<boolean> => (await d.view(node, { ...ctx, purpose: "recall" })) !== null;

  return {
    promote: async (sourceId: string, input: PromotionRequest) => {
      const request = assertPromotionRequest(sourceId, JSON.parse(JSON.stringify(input ?? null)) as unknown);
      const authorised = d.authorise("promote");
      return d.serialise(async () => {
        d.assertAuditUsable();
        const ctx = authorised();
        const { node: source, seen } = await d.visibleOrNotFound(sourceId, ctx);
        await d.guarded(ctx, [sourceId], async () => {
          // Promoting what you cannot fully see would publish, or confirm, the
          // part a policy hides from you (security review 2026-10, finding 1, applied to writes).
          if (canonicalJson(seen) !== canonicalJson(source)) deny("this actor sees the fact redacted, and cannot share what it cannot see");
          if (source.privacyClassification === "Sensitive" || source.privacyClassification === "Sealed") deny(`a ${source.privacyClassification} fact is never promoted`);
          if (source.retentionTier === "PendingDeletion" || source.contextualMetadata[DELETION_REQUEST] !== undefined) deny("the fact is in Recently deleted");
          if (source.validTo !== null) deny("the fact is no longer current; only a fact true now is promoted");
          if (scopesOf(source).includes(request.to)) deny(`the fact is already at ${request.to}`);
          // A retry, or a second click, must not leave the scope holding the same fact twice.
          const atScope = await d.inner.searchNodes({ labels: { label: "scope", in: [request.to] } });
          if (atScope.some((n) => promotionOf(n)?.from === sourceId && scopesOf(n).includes(request.to) && n.validTo === null && n.retentionTier !== "PendingDeletion")) {
            deny(`the fact is already promoted to ${request.to}; withdraw that copy to promote it again`);
          }
          await promotePolicies(source, request, ctx);
        });
        const text = request.text ?? source.content.text;
        const edited = text !== source.content.text;
        const record: PromotionRecord = {
          from: sourceId,
          by: ctx.actor,
          approvedBy: request.approvedBy ?? null,
          at: ctx.now.toISOString(),
          basis: request.basis,
          edited,
          ...(request.fields === undefined ? {} : { fields: request.fields }),
        };
        const author = source.contextualMetadata["author"];
        // Only the labels the convention defines: anything else on the source
        // was never approved for sharing, and a label can say more than the text.
        const copy: NewMemoryNode = {
          provenance: source.provenance,
          encryptionKeyRef: source.encryptionKeyRef,
          memoryType: source.memoryType,
          privacyClassification: source.privacyClassification === "Public" ? "Public" : "Private",
          retentionTier: "FullRetention",
          content: { text },
          contextualMetadata: { scope: request.to, ...(typeof author === "string" ? { author } : {}), [PROMOTION]: record },
          confidenceWeight: source.confidenceWeight,
          decayRate: source.decayRate,
          validFrom: source.validFrom,
          validTo: null,
        };
        const reason = JSON.stringify({
          to: request.to,
          basis: request.basis,
          approvedBy: record.approvedBy,
          edited,
          ...(request.fields === undefined ? {} : { fields: Object.keys(request.fields).sort() }),
        });
        d.assertAuditUsable();
        const saved = await d.commit(ctx, () => d.inner.addNode(copy), (s) => ({ ids: [sourceId, s.nodeId], reason }));
        return { copyId: saved.nodeId, event: d.allowedEvent(ctx, [sourceId, saved.nodeId], reason) };
      });
    },

    withdraw: async (copyId: string, reason: string) => {
      if (typeof copyId !== "string" || copyId === "") throw new Error("withdraw: the copy must be a fact id");
      if (typeof reason !== "string" || reason.trim() === "") throw new Error("withdraw: a reason is required");
      const authorised = d.authorise("withdraw");
      return d.serialise(async () => {
        d.assertAuditUsable();
        const ctx = authorised();
        const { node: existing, seen } = await d.visibleOrNotFound(copyId, ctx);
        if (promotionOf(existing) === null) throw new Error(`withdraw: ${copyId} is not a promoted copy; invalidate it instead`);
        // Already closed: nothing to withdraw, and a retry must not stamp a second retraction.
        if (existing.validTo !== null) return seen;
        const at = ctx.now.toISOString();
        const patch: NodePatch = { validTo: at, contextualMetadata: { ...existing.contextualMetadata, retraction: { at, by: "withdrawal", reason } } };
        let retracted: string[] = [];
        await d.guarded(ctx, [copyId], async () => {
          await d.updatePolicies(existing, patch, ctx);
          // What was concluded from the copy is retracted with it, in the same
          // transaction; the policies judge each of those now (cascade.ts).
          retracted = await judgeInvalidation(d.inner, existing, patch, ctx, d.updatePolicies, canSee(ctx));
        });
        d.assertAuditUsable();
        const updated = await d.commit(ctx, () => d.inner.updateNode(copyId, patch), () => ({ ids: [copyId, ...retracted], reason }));
        // As updateNode does: the closed fact as this actor sees it, else what
        // they already saw with its validity closed (never the stored labels).
        return (await d.view(updated, { ...ctx, purpose: "recall" })) ?? { ...seen, validTo: at, temporalAnchors: updated.temporalAnchors };
      });
    },
  };
}

export type PromotionCheck =
  | {
      ok: true;
      /** Where the `promote` event is in the trail. */
      event: { position: number; file?: string };
      /** Who promoted it, from which fact, when, and on what basis, as the event records it. */
      promotion: { from: string; actor: string; at: string; to: string; basis: string; approvedBy: string | null; edited: boolean };
      /** The `withdraw` event, if the copy has been withdrawn since. */
      withdrawn: { position: number; file?: string; at: string; actor: string; reason: string } | null;
    }
  | { ok: false; reason: string };

/**
 * Find a copy's promotion in a trail: the trail verifies, and exactly one
 * allowed `promote` event names `[source, copyId]`. `trail` is what
 * `verify-audit` takes (a database file, a JSONL log or a directory of them;
 * `key` is its HMAC key) or an open store that checks its own chain
 * (`SqliteMemoryStore`, `PostgresMemoryStore`). Reports a withdrawal, if any.
 *
 * A pass establishes what the chain establishes: the consent was recorded in
 * this trail and nothing about it was edited since.
 */
export async function verifyPromotion(copyId: string, trail: string | AuditVerifiable, opts: { key?: string; head?: string } = {}): Promise<PromotionCheck> {
  const promoted: { position: number; file?: string; event: AuditEvent }[] = [];
  const withdrawn: { position: number; file?: string; event: AuditEvent }[] = [];
  const visit: AuditVisitor = (event, position, file) => {
    if (event.outcome !== "allowed") return;
    const where = file === undefined ? { position, event } : { position, file, event };
    if (event.purpose === "promote" && event.count === 2 && event.nodeIds[1] === copyId) promoted.push(where);
    else if (event.purpose === "withdraw" && event.nodeIds[0] === copyId) withdrawn.push(where);
  };
  const verified = await visitTrail(trail, visit, opts);
  if (!verified.ok) return { ok: false, reason: `the audit trail does not verify: ${verified.reason}` };
  if (promoted.length === 0) return { ok: false, reason: `no promote event in this trail names ${copyId}` };
  if (promoted.length > 1) return { ok: false, reason: `${promoted.length} promote events name ${copyId}; a copy is promoted once` };
  const [{ event, ...where }] = promoted as [(typeof promoted)[number]];
  let said: { to?: unknown; basis?: unknown; approvedBy?: unknown; edited?: unknown };
  try {
    said = JSON.parse(event.reason ?? "") as typeof said;
  } catch {
    return { ok: false, reason: "the promote event's reason is not the promotion it records" };
  }
  if (typeof said.to !== "string" || typeof said.basis !== "string" || typeof said.edited !== "boolean" || !(said.approvedBy === null || typeof said.approvedBy === "string")) {
    return { ok: false, reason: "the promote event's reason is not the promotion it records" };
  }
  const last = withdrawn.at(-1);
  return {
    ok: true,
    event: where,
    promotion: { from: event.nodeIds[0]!, actor: event.actor, at: event.at, to: said.to, basis: said.basis, approvedBy: said.approvedBy, edited: said.edited },
    withdrawn:
      last === undefined
        ? null
        : { position: last.position, ...(last.file === undefined ? {} : { file: last.file }), at: last.event.at, actor: last.event.actor, reason: last.event.reason ?? "" },
  };
}
