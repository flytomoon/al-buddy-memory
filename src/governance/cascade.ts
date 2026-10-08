/**
 * The governed half of what a conclusion does when its source goes (derived.ts
 * has the store half). A store erases or retracts the whole closure in one
 * transaction; this is where the policies see ALL of it first, as one
 * decision, so an erase or an invalidation either reaches everything built on
 * the fact or changes nothing.
 *
 * Found in our 2026-09-22 review of the erase path.
 */
import { dependentsOf, isDependentsCapable, isInvalidation, retractionsFor, sourceRetraction } from "../derived.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { PolicyDenied, type NodePatch, type PolicyContext } from "./policy.js";

export type EraseCheck = (subject: { node: MemoryNode }, ctx: PolicyContext) => Promise<void>;
export type UpdateCheck = (existing: MemoryNode, patch: NodePatch, ctx: PolicyContext) => Promise<void>;
/** Whether the acting actor may read this fact (the governed handle's view). */
export type CanSee = (node: MemoryNode) => Promise<boolean>;

/**
 * How a refusal names the conclusion that stood in the way. One the actor
 * cannot read is not named, and neither is what the policy said about it: an
 * erase used to answer with a hidden conclusion's id and the hold placed on
 * it (security review 2026-10). The refusal is still audited, naming the root.
 */
async function blocker(node: MemoryNode, reason: string, canSee: CanSee | undefined, verb: string): Promise<string> {
  if (canSee === undefined || (await canSee(node))) return `${node.nodeId} was concluded from it and may not be ${verb} (${reason})`;
  return `a fact concluded from it, which this actor cannot see, may not be ${verb}`;
}

/**
 * The facts the cascade from `rootId` can reach, in `listNodes` order: every
 * fact, or only those resting on it when the store can find them by index.
 */
async function candidates(inner: MemoryStore, rootId: string): Promise<MemoryNode[]> {
  return isDependentsCapable(inner) ? inner.nodesRestingOn([rootId]) : inner.listNodes();
}

/** The facts built on `rootId`, read from the inner store (every tier: the cascade must reach hidden ones too). */
export async function closureOf(inner: MemoryStore, rootId: string): Promise<MemoryNode[]> {
  const nodes = await candidates(inner, rootId);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  return dependentsOf([rootId], nodes).map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Judge erasing `root` and everything built on it as one decision. The root's
 * own refusal comes back unchanged; a conclusion's refusal names that
 * conclusion, so the actor learns which fact stood in the way — when they can see it.
 */
export async function judgeErase(root: MemoryNode, closure: readonly MemoryNode[], ctx: PolicyContext, check: EraseCheck, canSee?: CanSee): Promise<void> {
  await check({ node: root }, ctx);
  for (const node of closure) {
    try {
      await check({ node }, ctx);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        throw new PolicyDenied(err.policy, `cannot erase ${root.nodeId}: ${await blocker(node, err.reason, canSee, "erased")}`);
      }
      throw err;
    }
  }
}

/**
 * The conclusions an invalidation will retract, and the update policies'
 * verdict on each retraction — judged before the change, like the change
 * itself. Returns their ids for the audit event.
 */
export async function judgeInvalidation(
  inner: MemoryStore,
  existing: MemoryNode,
  patch: NodePatch,
  ctx: PolicyContext,
  check: UpdateCheck,
  canSee?: CanSee,
): Promise<string[]> {
  const after = { validTo: patch.validTo === undefined ? existing.validTo : patch.validTo };
  if (!isInvalidation(existing, after) || after.validTo === null) return [];
  const nodes = await candidates(inner, existing.nodeId);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const retractions = retractionsFor(existing.nodeId, after.validTo, nodes);
  for (const r of retractions) {
    const node = byId.get(r.nodeId)!;
    const retract: NodePatch = { validTo: after.validTo, contextualMetadata: { ...node.contextualMetadata, retraction: sourceRetraction(r.because, ctx.now.toISOString()) } };
    try {
      await check(node, retract, ctx);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        throw new PolicyDenied(err.policy, `cannot retire ${existing.nodeId}: ${await blocker(node, err.reason, canSee, "retracted")}`);
      }
      throw err;
    }
  }
  return retractions.map((r) => r.nodeId);
}
