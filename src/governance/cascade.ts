/**
 * The governed half of what a conclusion does when its source goes (derived.ts
 * has the store half). A store erases or retracts the whole closure in one
 * transaction; this is where the policies see ALL of it first, as one
 * decision, so an erase or an invalidation either reaches everything built on
 * the fact or changes nothing.
 *
 * Found in our 2026-09-22 review of the erase path.
 */
import { dependentsOf, isInvalidation, retractionsFor, sourceRetraction } from "../derived.js";
import type { MemoryNode, MemoryStore } from "../types/memory.js";
import { PolicyDenied, type NodePatch, type PolicyContext } from "./policy.js";

export type EraseCheck = (subject: { node: MemoryNode }, ctx: PolicyContext) => Promise<void>;
export type UpdateCheck = (existing: MemoryNode, patch: NodePatch, ctx: PolicyContext) => Promise<void>;

/** The facts built on `rootId`, read from the inner store (every tier: the cascade must reach hidden ones too). */
export async function closureOf(inner: MemoryStore, rootId: string): Promise<MemoryNode[]> {
  const nodes = await inner.listNodes();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  return dependentsOf([rootId], nodes).map((id) => byId.get(id)!).filter(Boolean);
}

/**
 * Judge erasing `root` and everything built on it as one decision. The root's
 * own refusal comes back unchanged; a conclusion's refusal names that
 * conclusion, so he learns which fact stood in the way.
 */
export async function judgeErase(root: MemoryNode, closure: readonly MemoryNode[], ctx: PolicyContext, check: EraseCheck): Promise<void> {
  await check({ node: root }, ctx);
  for (const node of closure) {
    try {
      await check({ node }, ctx);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        throw new PolicyDenied(err.policy, `cannot erase ${root.nodeId}: ${node.nodeId} was concluded from it and may not be erased (${err.reason})`);
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
): Promise<string[]> {
  const after = { validTo: patch.validTo === undefined ? existing.validTo : patch.validTo };
  if (!isInvalidation(existing, after) || after.validTo === null) return [];
  const nodes = await inner.listNodes();
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const retractions = retractionsFor(existing.nodeId, after.validTo, nodes);
  for (const r of retractions) {
    const node = byId.get(r.nodeId)!;
    const retract: NodePatch = { validTo: after.validTo, contextualMetadata: { ...node.contextualMetadata, retraction: sourceRetraction(r.because, ctx.now.toISOString()) } };
    try {
      await check(node, retract, ctx);
    } catch (err) {
      if (err instanceof PolicyDenied) {
        throw new PolicyDenied(err.policy, `cannot retire ${existing.nodeId}: ${r.nodeId} was concluded from it and may not be retracted (${err.reason})`);
      }
      throw err;
    }
  }
  return retractions.map((r) => r.nodeId);
}
