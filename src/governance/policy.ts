/**
 * Governance hooks. The store ships the vocabulary (privacy classification,
 * retention tier, provenance); a policy is what ENFORCES it: who may write
 * what, who may see what, what may leave, what may be erased or shared. Policies
 * are plain objects with up to six hooks, composed in order, and every decision
 * is auditable.
 */
import type { Origin } from "../provenance.js";
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";

export type Purpose = "write" | "recall" | "export" | "invalidate" | "import" | "erase" | "promote" | "withdraw";

/** Why a promotion is allowed: its author's own act, an admin's approval of it, or a rule of the tenant. */
export type PromotionBasis = "self" | "admin-approved" | "policy";

/**
 * Structured fields captured when a fact is promoted — a form the person fills
 * in (category, outcome, a duration bucket), never inferred from the text.
 */
export type ProcessFields = Readonly<Record<string, string | number | boolean>>;

/** What `promote(sourceId, request)` asks for. */
export interface PromotionRequest {
  /** The scope the copy is written at: `team:<id>` or `org` in the teamMemory convention. */
  readonly to: string;
  /** The text the person approved. Default: the source's raw text, verbatim. */
  readonly text?: string | undefined;
  readonly fields?: ProcessFields | undefined;
  readonly basis: PromotionBasis;
  /** The approver's actor id; goes with `basis: "admin-approved"`. */
  readonly approvedBy?: string | undefined;
}

/** What an erasure would remove: a whole fact, or one link between facts. */
export type ErasureSubject = { node: MemoryNode } | { edgeId: string };

export interface PolicyContext {
  /** Who is acting: a user id, an agent name, a service. */
  actor: string;
  purpose: Purpose;
  /** Who will see the result, when different from the actor (an agent recalling on a user's behalf). */
  audience?: string | undefined;
  /**
   * What the application knows about the actor — teams, clients, regions,
   * roles, whatever its own rules are written in — taken from its own
   * authenticated context. A {@link ReadBoundary} refers to these by name.
   */
  attributes?: Readonly<Record<string, string | readonly string[]>> | undefined;
  /**
   * The app the actor is acting through (an MCP client, a host's agent), when
   * the host knows it. The audit event carries it; policies may read it, but
   * it is what a client said about itself, so it is not a credential.
   */
  origin?: Origin | undefined;
  now: Date;
}

/** One of the asking actor's attributes, by name: its value(s) from `ctx.attributes`. */
export interface ActorAttribute {
  readonly actor: string;
}

/**
 * A read rule declared as data: a filter over fact labels (keys of
 * `contextualMetadata`) compared with literal strings or the asking actor's
 * attributes. Equality, membership, AND and OR only — so the store can run it
 * inside its query, before ranking and before any limit.
 *
 * - `{ label, equals }`: the label is that string (or an array holding it).
 *   Against an attribute with several values it means "is one of them".
 * - `{ label, in }`: the label is one of these strings (or an array holding one).
 * - `{ all: [...] }` / `{ any: [...] }`: AND / OR.
 *
 * A missing label, a label of another type, or an attribute the actor does not
 * have matches nothing: a boundary fails closed.
 */
export type ReadBoundary =
  | { readonly label: string; readonly equals: string | ActorAttribute }
  | { readonly label: string; readonly in: readonly string[] | ActorAttribute }
  | { readonly all: readonly ReadBoundary[] }
  | { readonly any: readonly ReadBoundary[] };

export type NodePatch = Parameters<MemoryStore["updateNode"]>[1];

export interface GovernancePolicy {
  name: string;
  /**
   * Who may see what, declared as data. Every read applies it first — and a
   * store that understands label filters applies it inside its own query, so
   * facts outside it never take a place in a page — then `beforeRead` runs on
   * what it let through and has the final word. Several policies' boundaries
   * all apply (AND). Without one, reads behave exactly as before.
   */
  readBoundary?: ReadBoundary;
  /** Transform or refuse a fact before it is written. Throw {@link PolicyDenied} to refuse. */
  beforeWrite?(node: NewMemoryNode, ctx: PolicyContext): NewMemoryNode | Promise<NewMemoryNode>;
  /** Allow or refuse a change to an existing fact. Throw {@link PolicyDenied} to refuse. */
  beforeUpdate?(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): void | Promise<void>;
  /** Hide (null) or redact a fact on the way out of a recall. */
  beforeRead?(node: MemoryNode, ctx: PolicyContext): MemoryNode | null | Promise<MemoryNode | null>;
  /**
   * Decide whether a fact may leave in an export. Without it, export uses this
   * policy's beforeRead. With it, it REPLACES this policy's beforeRead on
   * export: nothing beforeRead hides or redacts applies, so a policy that
   * hides facts on read must repeat that rule here (and cannot redact — an
   * export carries a fact whole or not at all).
   */
  beforeExport?(node: MemoryNode, ctx: PolicyContext): boolean | Promise<boolean>;
  /**
   * Physically erasing a fact or a link — the one destructive operation, which
   * stewardship law requires to exist. Return `true` to allow, throw
   * {@link PolicyDenied} to refuse, return nothing to abstain. Erasure happens
   * only when at least one policy allowed it and none refused, so a policy that
   * merely protects some facts (guardian mode) never switches erasure on.
   */
  beforeErase?(subject: ErasureSubject, ctx: PolicyContext): boolean | void | Promise<boolean | void>;
  /**
   * Sharing a fact at another scope (`promote`): a new fact holding the text the
   * person approved. Same rule as erasure: return `true` to allow, throw
   * {@link PolicyDenied} to refuse, return nothing to abstain; a promotion
   * happens only when one policy allowed it and none refused. The write
   * policies do not run on the copy — this hook is its write rule. `source` is
   * the stored fact, which the actor can see whole (the store refuses a fact
   * they see redacted before any policy is asked).
   */
  beforePromote?(source: MemoryNode, request: PromotionRequest, ctx: PolicyContext): boolean | void | Promise<boolean | void>;
}

export class PolicyDenied extends Error {
  constructor(
    public readonly policy: string,
    public readonly reason: string,
  ) {
    super(`${policy}: ${reason}`);
    this.name = "PolicyDenied";
  }
}
