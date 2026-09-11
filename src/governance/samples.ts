/**
 * Three policies to copy. Each is a few lines on purpose: governance should
 * read like a rule a person can check, not a framework.
 */
import type { MemoryNode, NewMemoryNode } from "../types/memory.js";
import { PolicyDenied, type GovernancePolicy, type NodePatch, type PolicyContext } from "./policy.js";

/** Things that look like secrets. Conservative on purpose: a false Sensitive costs a click, a leaked key costs more. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/, // API tokens with a known prefix
  /\b(?:\d[ -]?){13,19}\b/, // card numbers
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b(?:password|passcode|passphrase|secret|api[_ -]?key|token)\s*[:=]\s*\S+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/**
 * Personal defaults: the owner sees everything; anything that looks like a
 * secret is written as Sensitive; Sensitive and Sealed facts never reach
 * another audience and never leave in an export unless the owner is exporting.
 */
export function personalDefaults(opts: { owner: string }): GovernancePolicy {
  const isOwner = (ctx: PolicyContext) => ctx.actor === opts.owner && (ctx.audience === undefined || ctx.audience === opts.owner);
  return {
    name: "personal-defaults",
    beforeWrite(node: NewMemoryNode): NewMemoryNode {
      if (node.privacyClassification !== "Sealed" && node.privacyClassification !== "Sensitive" && looksSecret(node.content.text)) {
        return { ...node, privacyClassification: "Sensitive", contextualMetadata: { ...node.contextualMetadata, classifiedBy: "personal-defaults" } };
      }
      return node;
    },
    beforeRead(node: MemoryNode, ctx: PolicyContext): MemoryNode | null {
      if (node.privacyClassification === "Sensitive" || node.privacyClassification === "Sealed") return isOwner(ctx) ? node : null;
      return node;
    },
    beforeExport(node: MemoryNode, ctx: PolicyContext): boolean {
      if (node.privacyClassification === "Sensitive" || node.privacyClassification === "Sealed") return ctx.actor === opts.owner;
      return true;
    },
  };
}

/**
 * Guardian mode: only a guardian may write a GuardianAdded fact, and only a
 * guardian may change or invalidate one. Everyone can still read them —
 * that is what they are for.
 */
export function guardianMode(opts: { guardians: string[] }): GovernancePolicy {
  const guardians = new Set(opts.guardians);
  return {
    name: "guardian-mode",
    beforeWrite(node: NewMemoryNode, ctx: PolicyContext): NewMemoryNode {
      if (node.provenance === "GuardianAdded" && !guardians.has(ctx.actor)) throw new PolicyDenied("guardian-mode", `${ctx.actor} is not a guardian and cannot write a GuardianAdded fact`);
      return node;
    },
    beforeUpdate(existing: MemoryNode, _patch: NodePatch, ctx: PolicyContext): void {
      if (existing.provenance === "GuardianAdded" && !guardians.has(ctx.actor)) throw new PolicyDenied("guardian-mode", `${ctx.actor} cannot change a guardian's fact`);
    },
  };
}

/**
 * Enterprise audit: every decision is already in the audit trail; this policy
 * adds the two rules reviewers ask for first. AI-inferred facts below a
 * confidence floor are hidden from everyone but reviewers, and nothing leaves
 * in an export unless the actor is an exporter.
 */
export function enterpriseAudit(opts: { reviewers: string[]; exporters: string[]; minInferredConfidence?: number }): GovernancePolicy {
  const reviewers = new Set(opts.reviewers);
  const exporters = new Set(opts.exporters);
  const floor = opts.minInferredConfidence ?? 0.5;
  return {
    name: "enterprise-audit",
    beforeRead(node: MemoryNode, ctx: PolicyContext): MemoryNode | null {
      if (node.provenance === "AIInferred" && node.confidenceWeight < floor && !reviewers.has(ctx.actor)) return null;
      return node;
    },
    beforeExport(_node: MemoryNode, ctx: PolicyContext): boolean {
      return exporters.has(ctx.actor);
    },
  };
}
