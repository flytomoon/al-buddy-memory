/**
 * Governed operations: methods a package outside this one adds to a `govern()`
 * handle, run through that handle's own queue, policies and audit
 * (docs/EXTENSION-POINTS.md#governedoperations-new-methods-on-a-governed-handle).
 *
 * The handle lends an operation the same helpers Recently deleted is built on,
 * rather than letting it reach for them, so an operation that uses the kit
 * cannot skip the queue, a visibility check or the audit. An operation is
 * trusted code — it is handed the inner store — and is installed by whoever
 * builds the handle, never by a caller of it.
 */
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import type { AuditEvent } from "./audit.js";
import { CORE_PURPOSES, type GovernancePolicy, type NodePatch, type PolicyContext, type Purpose } from "./policy.js";

/** What the governed handle lends an operation: its queue, checks, audit and views. */
export interface GovernedKit {
  /** The store being governed. Write to it only inside `commit`. */
  readonly inner: MemoryStore;
  /** The handle's policies, in order. An operation's own hook is read off them (a policy may carry more than `GovernancePolicy` names). */
  readonly policies: readonly GovernancePolicy[];
  /**
   * Who is acting, decided now; when, read when the returned function is called
   * (inside `serialise`). `purpose` must be one this operation declared.
   */
  authorise(purpose: Purpose): () => PolicyContext;
  /** Run `step` holding the handle's lock (`GovernOptions.lock`), after every mutation queued before it. */
  serialise<T>(step: () => Promise<T>): Promise<T>;
  /** Throw if the audit sink has failed before; call it before the first read and again before writing. */
  assertAuditUsable(): void;
  /**
   * The stored fact and the actor's view of it, or "Memory node not found"
   * (audited as denied) when the actor cannot see it.
   */
  visibleOrNotFound(nodeId: string, ctx: PolicyContext): Promise<{ node: MemoryNode; seen: MemoryNode }>;
  /** Run policy checks; a `PolicyDenied` from them is audited as denied, then rethrown. */
  guarded<T>(ctx: PolicyContext, ids: string[], step: () => Promise<T>): Promise<T>;
  /**
   * The mutation and its "allowed" event. On the store's own audit table they
   * are one transaction; on any other sink the event follows the write.
   */
  commit<T>(ctx: PolicyContext, mutate: () => Promise<T>, describe: (result: T) => { ids: string[]; reason?: string }): Promise<T>;
  /** The "allowed" event `commit` records for these ids and reason. */
  allowedEvent(ctx: PolicyContext, ids: string[], reason?: string): AuditEvent;
  /** A fact as this actor may see it, or null. */
  view(node: MemoryNode, ctx: PolicyContext): Promise<MemoryNode | null>;
  /** Every policy's `beforeUpdate`, in order. */
  updatePolicies(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): Promise<void>;
  /**
   * What closing `existing` with `patch` retracts with it (conclusions drawn
   * from it), each judged by the update policies now. Returns their ids; the
   * retractions are written by `commit`'s mutation (the store's cascade).
   */
  invalidationCascade(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): Promise<string[]>;
}

/** An async method an operation adds to the handle. */
export type GovernedMethod = (...args: never[]) => Promise<unknown>;

/** A set of methods to add to a governed handle (`GovernOptions.operations`). */
export interface GovernedOperations {
  /** Who these operations are, in errors. */
  readonly name: string;
  /** The audit purposes they run under. None may be a core purpose (`CORE_PURPOSES`) or another operation's. */
  readonly purposes: readonly string[];
  /** Build the methods over this handle's kit. A name the handle already has is refused. */
  methods(kit: GovernedKit): Readonly<Record<string, GovernedMethod>>;
}

/**
 * Check every set of operations before a handle is built: a purpose of the
 * core's, or one claimed twice, would let an operation's events and contexts
 * pass for something they are not.
 */
export function assertOperations(operations: readonly GovernedOperations[]): void {
  const claimed = new Map<string, string>();
  for (const op of operations) {
    if (typeof op?.name !== "string" || op.name === "") throw new Error("govern: every operation set needs a name");
    if (typeof op.methods !== "function") throw new Error(`govern: operations ${op.name} have no methods()`);
    if (!Array.isArray(op.purposes) || op.purposes.length === 0) throw new Error(`govern: operations ${op.name} must declare their purposes`);
    for (const purpose of op.purposes) {
      if (typeof purpose !== "string" || !/^[a-z][a-z0-9-]*$/.test(purpose)) throw new Error(`govern: operations ${op.name}: a purpose is a lowercase name, not ${JSON.stringify(purpose)}`);
      if ((CORE_PURPOSES as readonly string[]).includes(purpose)) throw new Error(`govern: operations ${op.name} cannot run under the core purpose "${purpose}"`);
      const other = claimed.get(purpose);
      if (other !== undefined) throw new Error(`govern: the purpose "${purpose}" is claimed by both ${other} and ${op.name}`);
      claimed.set(purpose, op.name);
    }
  }
}
