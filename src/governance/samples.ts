/**
 * Policies to copy. Each is a few lines on purpose: governance should read
 * like a rule a person can check, not a framework.
 */
import { canonicalJson } from "../history.js";
import type { MemoryNode, NewMemoryNode } from "../types/memory.js";
import { PolicyDenied, type ErasureSubject, type GovernancePolicy, type NodePatch, type PolicyContext, type PromotionRequest } from "./policy.js";
import { PROMOTION, promotionOf } from "./promotion.js";

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

/** A fact's `scope` label as a list; `undefined` when it is not a string or a list of strings. */
function scopesOf(node: Pick<MemoryNode, "contextualMetadata">): readonly string[] | undefined {
  const scope = node.contextualMetadata["scope"];
  if (scope === undefined) return [];
  if (typeof scope === "string") return [scope];
  return Array.isArray(scope) && scope.every((s) => typeof s === "string") ? scope : undefined;
}

/** One scope label or several, in one comparable form: order and repeats do not change a scope. */
const sameScope = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown) => (typeof v === "string" ? [v] : Array.isArray(v) ? [...new Set(v)].sort() : v);
  return JSON.stringify(norm(a) ?? null) === JSON.stringify(norm(b) ?? null);
};

/**
 * The attributes {@link teamMemory}'s boundary reads, from who the actor is and
 * what the application knows about them (an OIDC token's mapped claims, say):
 * `self` is `user:<actor>`, and each of `teams` becomes `team:<id>`. Every
 * team is prefixed, already-prefixed ones too, so a directory group named
 * `org` or `user:someone` is a team like any other and cannot widen a read.
 * A `self` among the attributes is replaced. The rest pass through unchanged.
 */
export function teamMemoryAttributes(actor: string, attributes: Readonly<Record<string, string | readonly string[]>> = {}): Record<string, string | readonly string[]> {
  const raw = attributes["teams"];
  const teams = (raw === undefined ? [] : typeof raw === "string" ? [raw] : raw).filter((t) => typeof t === "string" && t !== "");
  return { ...attributes, self: `user:${actor}`, teams: [...new Set(teams)].map((t) => `team:${t}`) };
}

/** What {@link TeamMemoryOptions.approval} is asked about: one promotion, and who is said to have approved it. */
export interface PromotionApproval {
  readonly approvedBy: string;
  readonly sourceId: string;
  readonly author: string;
  readonly to: string;
}

export interface TeamMemoryOptions {
  /** Actors whose imports restore facts verbatim, scope, author and promotion record included. */
  readonly importers?: readonly string[] | undefined;
  /** Let an author promote their own fact to `org` without an admin's approval. Off by default. */
  readonly orgSelfServe?: boolean | undefined;
  /**
   * Whether `approvedBy` is an admin who really approved exactly this
   * promotion: your approval workflow's record, read from where you keep it.
   * The promoting call is made by the author, so a name in `approvedBy` is
   * only a claim until something you trust confirms it. Without this, the one
   * approval accepted is an admin's of their own fact (`approvedBy` = the actor,
   * who has the `admin` role).
   */
  readonly approval?: ((approval: PromotionApproval, ctx: PolicyContext) => boolean | Promise<boolean>) | undefined;
}

/** One attribute's values as a list. */
const valuesOf = (ctx: PolicyContext, name: string): readonly string[] => {
  const raw = ctx.attributes?.[name];
  return raw === undefined ? [] : typeof raw === "string" ? [raw] : raw;
};

/** The acting actor has the `admin` role (attribute `roles`, from the identity provider's claims). */
const isAdmin = (ctx: PolicyContext): boolean => valuesOf(ctx, "roles").includes("admin");

/**
 * Team memory: one company's store, in layers. A fact's `scope` label says who
 * reads it — `user:<actor>` (its writer), `team:<id>` (a team), `org` (everyone
 * in the tenant), or a list of these — and `author` says who asserted it. The
 * tenant stays the wall between companies; scope is a label inside it.
 *
 * - Reads: a fact is visible when its scope is the actor's own, one of the
 *   actor's teams, or `org`. The store applies this inside its query; each fact
 *   is then checked again against the actor itself, so a context that forgot
 *   {@link teamMemoryAttributes} hides facts rather than showing them.
 * - Writes: an unlabelled fact is stamped `scope: user:<actor>` and
 *   `author: <actor>`, so nothing is shared by accident. A write naming another
 *   scope or another author, or carrying a promotion record, is refused:
 *   sharing is a promotion, not a label. An import restores facts verbatim only
 *   for `importers`; anyone else's is judged as a write.
 * - Changes: `scope`, `author` and a copy's promotion record never change.
 * - Promotion (`promote`) is the only way across scopes, and it writes a new
 *   fact. Only the fact's author promotes it: to a team they are on, on their
 *   own; to `org` with an admin's approval ({@link TeamMemoryOptions.approval})
 *   or `orgSelfServe`. An admin cannot complete someone else's promotion
 *   without them, and approved text that reads like a secret is refused.
 * - Withdrawal (`withdraw`): the copy's author, whoever promoted it, or an admin.
 *
 * See docs/policies/scopes.md.
 */
export function teamMemory(opts: TeamMemoryOptions = {}): GovernancePolicy {
  const importers = new Set(opts.importers ?? []);
  const deny = (why: string): never => {
    throw new PolicyDenied("team-memory", why);
  };
  const approved = async (approval: PromotionApproval, ctx: PolicyContext): Promise<boolean> => {
    if (opts.approval !== undefined) return (await opts.approval(approval, ctx)) === true;
    return approval.approvedBy === ctx.actor && isAdmin(ctx);
  };
  return {
    name: "team-memory",
    readBoundary: {
      any: [
        { label: "scope", equals: { actor: "self" } },
        { label: "scope", in: { actor: "teams" } },
        { label: "scope", equals: "org" },
      ],
    },
    // The same rule, from the actor itself rather than the `self` attribute.
    // With teamMemoryAttributes in the context it hides nothing the boundary
    // let through, so pages are unchanged; without it, it fails closed.
    beforeRead(node: MemoryNode, ctx: PolicyContext): MemoryNode | null {
      const raw = ctx.attributes?.["teams"];
      const teams = raw === undefined ? [] : typeof raw === "string" ? [raw] : raw;
      const visible = (scopesOf(node) ?? []).some((s) => s === `user:${ctx.actor}` || s === "org" || (s.startsWith("team:") && teams.includes(s)));
      return visible ? node : null;
    },
    beforeWrite(node: NewMemoryNode, ctx: PolicyContext): NewMemoryNode {
      if (ctx.purpose === "import" && importers.has(ctx.actor)) return node;
      const labels = node.contextualMetadata;
      const scopes = scopesOf(node);
      if (scopes === undefined) deny("scope must be a string or a list of strings");
      if (scopes!.some((s) => s !== `user:${ctx.actor}`)) deny(`${ctx.actor} writes to their own scope only (user:${ctx.actor}); promotion is the only way to share a fact`);
      if (labels["author"] !== undefined && labels["author"] !== ctx.actor) deny(`${ctx.actor} cannot write a fact authored by someone else`);
      // A forged record would let a fact pass for a promoted copy (withdraw, verifyPromotion's reader).
      if (labels[PROMOTION] !== undefined) deny("a promotion record is written by promote, not by a write");
      if (scopes!.length > 0 && labels["author"] !== undefined) return node;
      return { ...node, contextualMetadata: { ...labels, scope: scopes!.length > 0 ? labels["scope"] : `user:${ctx.actor}`, author: ctx.actor } };
    },
    // A patch's contextualMetadata replaces the old one whole, so leaving a
    // label out is a change too.
    beforeUpdate(existing: MemoryNode, patch: NodePatch, ctx: PolicyContext): void {
      const copy = promotionOf(existing);
      // Closing a promoted copy, by withdraw or any other route, is for the
      // person it came from, whoever shared it, or an admin — not for every reader.
      if (copy !== null && patch.validTo !== undefined && patch.validTo !== existing.validTo) {
        if (ctx.actor !== existing.contextualMetadata["author"] && ctx.actor !== copy.by && !isAdmin(ctx)) {
          deny(`${ctx.actor} cannot withdraw a promoted fact: its author, whoever promoted it, or an admin can`);
        }
      }
      if (patch.contextualMetadata === undefined) return;
      if (!sameScope(existing.contextualMetadata["scope"], patch.contextualMetadata["scope"])) deny("a fact's scope never changes; promote it to share it");
      if (existing.contextualMetadata["author"] !== patch.contextualMetadata["author"]) deny("a fact's author never changes");
      if (canonicalJson(existing.contextualMetadata[PROMOTION] ?? null) !== canonicalJson(patch.contextualMetadata[PROMOTION] ?? null)) deny("a promoted fact's promotion record never changes");
    },
    // govern() has already refused a fact this actor sees redacted, a Sensitive
    // or Sealed one, one in Recently deleted and one no longer current.
    async beforePromote(source: MemoryNode, request: PromotionRequest, ctx: PolicyContext): Promise<true> {
      const author = source.contextualMetadata["author"];
      // The "not spying" rule: whoever else asks, the author's own call completes it.
      if (typeof author !== "string" || author !== ctx.actor) deny(`only a fact's author promotes it; ${ctx.actor} is not its author (an admin approves through approvedBy on the author's promotion)`);
      if (request.to !== "org" && !(request.to.startsWith("team:") && request.to.length > "team:".length)) deny("a fact is promoted to team:<id> or org");
      if (request.to !== "org" && !valuesOf(ctx, "teams").includes(request.to)) deny(`${ctx.actor} is not on ${request.to}`);
      if (request.basis === "admin-approved") {
        const approval: PromotionApproval = { approvedBy: request.approvedBy ?? "", sourceId: source.nodeId, author: author as string, to: request.to };
        if (!(await approved(approval, ctx))) deny(`no admin approval by ${approval.approvedBy} is on record for this promotion`);
      } else if (request.to === "org" && opts.orgSelfServe !== true) {
        deny("promotion to org needs an admin's approval (basis admin-approved, with approvedBy) unless the tenant allows orgSelfServe");
      }
      // The same net the personal defaults classify by, on the words that would
      // be shared — the source's own when not edited, since a store without
      // that policy never classified them.
      if (looksSecret(request.text ?? source.content.text)) deny("the approved text reads like a secret, and secrets never leave a person's own scope");
      return true;
    },
  };
}
