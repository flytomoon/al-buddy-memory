/**
 * Three policies to copy. Each is a few lines on purpose: governance should
 * read like a rule a person can check, not a framework.
 */
import type { MemoryNode, NewMemoryNode } from "../types/memory.js";
import { PolicyDenied, type ErasureSubject, type GovernancePolicy, type NodePatch, type PolicyContext } from "./policy.js";

/**
 * Shapes that look like secrets. A HEURISTIC, and only the shapes listed here:
 * it is a net with a known mesh, not comprehensive secret detection, and
 * anything unusual will pass straight through it.
 *
 * It used to be `password:`-shaped — the label form required a colon or an
 * equals sign — so "my wifi password: hunter2" was hidden and "the wifi
 * password is hunter2", which is how a person actually speaks one into a memory
 * system, was written Private and read straight back to the assistant. AWS
 * keys, JWTs and bearer tokens went through too (Astra R10 + Fable,
 * 2026-09-18).
 *
 * Conservative on purpose in the other direction: "the secret is out" is
 * classified Sensitive, and a false Sensitive costs a click while a leaked key
 * costs more.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/, // API tokens with a known prefix
  /\b(?:\d[ -]?){13,19}\b/, // card numbers
  /\b\d{3}-\d{2}-\d{4}\b/, // US SSN shape
  /\b(?:password|passcode|passphrase|pin|secret|api[_ -]?key|token)\s*[:=]\s*\S+/i, // "password: hunter2"
  /\b(?:password|passcode|passphrase|pin|secret|api[_ -]?key|token)\s+(?:is|was)\s+\S+/i, // "the password is hunter2"
  /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|APKA|AROA|ASCA)[A-Z0-9]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/, // JWT (header always starts "eyJ")
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i, // bearer token in an Authorization header
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** True when the text matches one of {@link SECRET_PATTERNS}. Nothing more is claimed. */
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/**
 * Personal defaults: one person's memory. The owner sees everything; anything
 * that looks like a secret is written as Sensitive; Sensitive and Sealed facts
 * never reach another audience, never leave in an export, and are never erased,
 * unless the owner is acting in person (actor = owner, no other audience); only
 * the owner's actor changes a fact. The model it assumes: the owner is the
 * actor, and an assistant working for them is a different AUDIENCE.
 */
export function personalDefaults(opts: { owner: string }): GovernancePolicy {
  const isOwner = (ctx: PolicyContext) => ctx.actor === opts.owner && (ctx.audience === undefined || ctx.audience === opts.owner);
  return {
    name: "personal-defaults",
    beforeWrite(node: NewMemoryNode, ctx: PolicyContext): NewMemoryNode {
      // Import restores facts verbatim, history and all: the owner's act, not a stranger's.
      if (ctx.purpose === "import" && ctx.actor !== opts.owner) {
        throw new PolicyDenied("personal-defaults", `${ctx.actor} is not the owner and cannot import memory`);
      }
      if (node.privacyClassification !== "Sealed" && node.privacyClassification !== "Sensitive" && looksSecret(node.content.text)) {
        return { ...node, privacyClassification: "Sensitive", contextualMetadata: { ...node.contextualMetadata, classifiedBy: "personal-defaults" } };
      }
      return node;
    },
    beforeRead(node: MemoryNode, ctx: PolicyContext): MemoryNode | null {
      if (node.privacyClassification === "Sensitive" || node.privacyClassification === "Sealed") return isOwner(ctx) ? node : null;
      return node;
    },
    // Export and erasure are judged like reads — by actor AND audience — so an
    // agent acting for the owner cannot carry Sensitive facts out, or erase
    // anything, just because the actor is the owner. They tested the actor only
    // (Fable final review, 2026-09-15).
    beforeExport(node: MemoryNode, ctx: PolicyContext): boolean {
      if (node.privacyClassification === "Sensitive" || node.privacyClassification === "Sealed") return isOwner(ctx);
      return true;
    },
    beforeErase(_subject: ErasureSubject, ctx: PolicyContext): true {
      if (!isOwner(ctx)) throw new PolicyDenied("personal-defaults", `only the owner, in person, erases memory (actor ${ctx.actor}, audience ${ctx.audience ?? "none"})`);
      return true;
    },
    // Changes are the owner's too. By actor only: an assistant acting for the
    // owner (audience "agent") must still be able to invalidate a fact.
    beforeUpdate(_existing: MemoryNode, _patch: NodePatch, ctx: PolicyContext): void {
      if (ctx.actor !== opts.owner) throw new PolicyDenied("personal-defaults", `${ctx.actor} is not the owner and cannot change the owner's memory`);
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
    // Refuses a non-guardian erasing a guardian's fact; otherwise abstains —
    // it never switches erasure on by itself.
    beforeErase(subject: ErasureSubject, ctx: PolicyContext): void {
      if ("node" in subject && subject.node.provenance === "GuardianAdded" && !guardians.has(ctx.actor)) {
        throw new PolicyDenied("guardian-mode", `${ctx.actor} cannot erase a guardian's fact`);
      }
    },
  };
}

/**
 * Memory lock: while it is installed and locked, nothing is erased — by
 * anyone, the owner in person included. Erasure needs one allow and no
 * refusal, so this refusal wins over every other policy, in any order.
 *
 * Unlocking is a deliberate act: take the policy out of the list, or pass
 * `isLocked` and change what it reads (a settings toggle, say). If `isLocked`
 * throws, erasure is refused: a lock that cannot be read stays shut.
 *
 * What it does not cover, said plainly: it guards the governed handle. The raw
 * store and the database file are outside every policy — backups are the
 * answer to those. And invalidation is not erasure: a fact can still be closed
 * with `validTo`, which is how memory is meant to change anyway.
 */
export function memoryLock(opts: { isLocked?: () => boolean } = {}): GovernancePolicy {
  const isLocked = opts.isLocked ?? (() => true);
  return {
    name: "memory-lock",
    beforeErase(_subject: ErasureSubject, _ctx: PolicyContext): void {
      let locked = true;
      try {
        // Only an explicit false unlocks. A setting that is missing reads as
        // undefined from JavaScript, and a missing setting is not a decision.
        locked = isLocked() !== false;
      } catch {
        // Fail closed: stay locked.
      }
      if (locked) throw new PolicyDenied("memory-lock", "memory is locked: nothing can be erased until the lock is lifted");
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
  const hidden = (node: MemoryNode, ctx: PolicyContext) => node.provenance === "AIInferred" && node.confidenceWeight < floor && !reviewers.has(ctx.actor);
  return {
    name: "enterprise-audit",
    beforeRead(node: MemoryNode, ctx: PolicyContext): MemoryNode | null {
      return hidden(node, ctx) ? null : node;
    },
    // On export this replaces beforeRead, so the hiding rule is repeated here:
    // an exporter who is not a reviewer exported the weak facts every read hid
    // from them, history included (review 2026-09-22).
    beforeExport(node: MemoryNode, ctx: PolicyContext): boolean {
      return exporters.has(ctx.actor) && !hidden(node, ctx);
    },
  };
}
