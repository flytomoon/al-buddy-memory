/**
 * Governance hooks. The store ships the vocabulary (privacy classification,
 * retention tier, provenance); a policy is what ENFORCES it: who may write
 * what, who may see what, what may leave. Policies are plain objects with up
 * to four hooks, composed in order, and every decision is auditable.
 */
import type { MemoryNode, MemoryStore, NewMemoryNode } from "../types/memory.js";

export type Purpose = "write" | "recall" | "export" | "invalidate";

export interface PolicyContext {
  /** Who is acting: a user id, an agent name, a service. */
  actor: string;
  purpose: Purpose;
  /** Who will see the result, when different from the actor (an agent recalling on a user's behalf). */
  audience?: string | undefined;
  now: Date;
}

export type NodePatch = Parameters<MemoryStore["updateNode"]>[1];

export interface GovernancePolicy {
  name: string;
  /** Transform or refuse a fact before it is written. Throw {@link PolicyDenied} to refuse. */
  beforeWrite?(node: NewMemoryNode, ctx: PolicyContext): NewMemoryNode | Promise<NewMemoryNode>;
  /** Allow or refuse a change to an existing fact. Throw {@link PolicyDenied} to refuse. */
  beforeUpdate?(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): void | Promise<void>;
  /** Hide (null) or redact a fact on the way out of a recall. */
  beforeRead?(node: MemoryNode, ctx: PolicyContext): MemoryNode | null | Promise<MemoryNode | null>;
  /** Decide whether a fact may leave in an export. Defaults to beforeRead's answer. */
  beforeExport?(node: MemoryNode, ctx: PolicyContext): boolean | Promise<boolean>;
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
