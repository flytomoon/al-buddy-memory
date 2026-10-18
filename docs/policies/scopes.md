# Scopes: personal, team and company memory in one store

One company's memory has layers: what a person keeps for themselves, what a team shares, and what
the whole company knows. They are one store with one label, not three stores. The tenant (the
company) stays the wall: every statement is keyed to it, and nothing on this page crosses it.
Inside it, two labels on a fact's `contextualMetadata` say who reads it and who said it:

| Label | Value | Means |
|---|---|---|
| `scope` | `"user:<actor>"` | that person's own fact; nobody else reads it |
| | `"team:<id>"` | everyone on team `<id>` reads it |
| | `"org"` | everyone in the tenant reads it |
| | a list of these, e.g. `["team:blue", "team:red"]` | anyone any one of them admits |
| `author` | `"<actor>"` | who asserted the fact; kept when it is shared |

These are a convention over [data boundaries](boundaries.md), not a schema change: the store
already applies a label rule inside its own query, on SQLite, Postgres and in-memory alike, and a
fact's labels travel in the portable format as they are.

## The sample policy: `teamMemory`

`teamMemory()` (in `al-buddy-memory`, source in
[src/governance/samples.ts](../../src/governance/samples.ts)) is the rule written once:

```ts
readBoundary: {
  any: [
    { label: "scope", equals: { actor: "self" } },  // "user:<actor>"
    { label: "scope", in: { actor: "teams" } },     // "team:<id>" for each of the actor's teams
    { label: "scope", equals: "org" },
  ],
},
```

- **Reads.** A fact is visible when its scope is the actor's own, one of the actor's teams, or
  `org`. The store applies this before ranking and before any `limit`, on every read: search,
  `getNode`, `listNodes`, history, export. A fact outside it is "not found" to updates, erasures
  and links. Each fact the boundary lets through is then checked again against the actor itself,
  so a context that hands someone another person's `self` shows nothing extra.
- **Writes.** A fact written without a `scope` is stamped `scope: "user:<actor>"`, and one
  without an `author` is stamped `author: "<actor>"`, so nothing is shared by accident. A write
  that names any other scope, or another author, is refused with `PolicyDenied`: a label is not
  how a fact reaches a team.
- **Changes.** `scope` and `author` never change. An update that sets either to something else,
  or drops either (a patch's `contextualMetadata` replaces the old one whole), is refused, and so
  is a restore over an existing fact that would. Anything else about a fact may change as before,
  and invalidation closes `validTo` with both labels intact: a fact is never moved, and never
  deleted to be moved.
- **Imports.** `teamMemory({ importers: ["ops"] })` lets the named actors restore facts verbatim,
  scope and author included: a backup of team and company memory has to come back as it was.
  Anyone else's import is judged as a write.

Sharing a fact with a team or the company is a **promotion** (next section): a new fact at the
target scope, holding the text its author approved, with the consent in the audit trail, the
original untouched. Otherwise a fact reaches a `team:` or `org` scope only through an import by
one of `importers` (or through the raw store, which no policy governs).

## Promotion

Every governed handle has two more methods:

```ts
const { copyId, event } = await store.promote(sourceId, {
  to: "team:blue",            // or "org"
  text: "Deploys go out on Tuesdays",  // optional: the text the person approved; default the fact's own words
  fields: { category: "release" },     // optional: structured fields from a form, never inferred
  basis: "self",              // "self" | "admin-approved" | "policy"
  approvedBy: undefined,      // the approver's actor id, with basis "admin-approved"
});
await store.withdraw(copyId, "replaced by the handbook");
await verifyPromotion(copyId, trail);  // the trail verifies and holds the promote event
```

**What `promote` writes.** A new fact: the approved text as its content, the source's
provenance, confidence and `validFrom`, classification `Private` (`Public` stays `Public`),
`scope` = the target, `author` = the source's author, and
`promotion: { from, by, approvedBy, at, basis, edited, fields? }`. No other label is copied:
the person approved the text, and a tag can say more than the text does. The source is not
touched: no edit, no link. One audit event, purpose `promote`, names `[sourceId, copyId]`, and
its reason is `{ to, basis, approvedBy, edited, fields }` with the field *names* only. That
event is the consent record, chained like every other; the copy's `promotion` label is a
convenience. `verifyPromotion(copyId, trail)` (a store, or a path `verify-audit` takes) checks
the trail and finds it, and reports a later withdrawal.

**What no policy can switch on.** The store refuses, before any policy is asked:

- a fact the promoter cannot see ("not found", as everywhere);
- a fact the promoter sees **redacted** — sharing what you cannot fully see would publish, or
  confirm, the part hidden from you;
- `Sensitive` and `Sealed` facts, which never leave a person's own scope;
- a fact in Recently deleted (`PendingDeletion`) or no longer current (`validTo` set);
- a target the fact is already at, and a second live copy of the same fact at the same scope
  (a retry, or two clicks at once, makes one copy; withdraw it to promote again).

Then the `beforePromote` hooks decide, as erasure does: one must allow and none refuse. A store
whose policies have no `beforePromote` (the shipped personal server's, for one) promotes nothing.

**What `teamMemory` allows.**

| | Who | Needs |
|---|---|---|
| to `team:<id>` | the fact's author, on that team | nothing more (basis `self` or `policy`) |
| to `org` | the fact's author | `basis: "admin-approved"` with an approval on record, or `teamMemory({ orgSelfServe: true })` |

- **Only the author completes a promotion.** An admin who can read someone's team fact still
  cannot promote it: the call that completes it is the author's, with the admin in `approvedBy`.
  Either one alone is refused.
- **An approval is checked, not taken on trust.** The author makes the call, so `approvedBy`
  is only a name until something you trust confirms it: pass
  `teamMemory({ approval: ({ approvedBy, sourceId, author, to }, ctx) => … })` to read your
  approval workflow's record, and return `true` only when `approvedBy` is an admin who approved
  exactly this promotion. Without it, the one approval accepted is an admin's own, on their own
  fact (`approvedBy` = the actor, whose `roles` include `admin`).
- **Text that reads like a secret is refused**, edited or not (the `looksSecret` net the personal
  defaults classify with).
- **Withdrawal** closes the copy's `validTo` with
  `retraction: { at, by: "withdrawal", reason }`, purpose `withdraw`; the copy, its text and its
  history stay. Its author, whoever promoted it, or an admin may withdraw it, and only they may
  close it any other way (an `updateNode` setting `validTo`). Withdrawing a copy that is already
  closed changes nothing and records nothing.
- **The `promotion` record never changes**, and a write or a non-importer's import carrying
  one is refused, so a fact cannot pass for a copy.

**Erasure.** A copy is the organisation's: erasing its source leaves it, and the erasure
receipt says so in `outside`. The person keeps a one-call exit (`withdraw`), and a subject
erasure, `eraseWhere({ label: "author", equals: "<actor>" })`, reaches every copy the eraser can
read, each judged by the erase policies, so a legal hold can still refuse one.

**Over MCP.** The governance server has `promote` (`id`, `to`, optional `text`, `basis`,
`approvedBy`, `fields`) and `withdraw` (`id`, `reason`). They call the store's own methods, so
a team server governed by `teamMemory` judges them exactly as above; with `approvedBy` and no
`basis`, the basis is `admin-approved`. On the personal server, whose policy has no
`beforePromote`, both are refused.

**The portable format is unchanged.** A copy is a fact with labels and travels as one.

## Wiring it up

The boundary reads two actor attributes, `self` and `teams`, and expects the teams already
written as scopes. `teamMemoryAttributes(actor, attributes)` makes them from what your
application knows: `self` becomes `user:<actor>`, each team becomes `team:<id>`, and every other
attribute passes through.

```ts
import { govern, storeAudit, teamMemory, teamMemoryAttributes } from "al-buddy-memory";

const store = govern(inner, {
  policies: [teamMemory()],
  context: () => ({ actor: user.id, attributes: teamMemoryAttributes(user.id, { teams: user.teams, roles: user.roles }) }),
  audit: storeAudit(inner),
});
```

Behind the HTTP server signed in by your identity provider, the teams come from the token: map
the groups claim to `teams` (`claims: { groups: "teams" }`) and pass the verified identity
through, as [SIGN-IN.md](../SIGN-IN.md#team-memory) shows.

## What to know

- **It fails closed.** A fact with no `scope`, or one that is not a string or a list of strings,
  is visible to nobody. An actor with no `self` attribute sees no personal facts; one with no
  `teams` sees no team facts. Facts written before the policy was installed carry no scope, so
  label them on the raw store before you install it, or nobody will see them.
- **Every team is prefixed, even one that looks prefixed.** A directory group named `org`
  becomes `team:org`, and one named `user:someone` becomes `team:user:someone`. Whoever can name
  a group at your provider cannot use the name to read the company's or a person's facts. Pass
  team ids as your directory has them, without the prefix.
- **A `self` among the attributes is replaced**, so a claim mapped to `self` cannot name
  someone else.
- **Classification is a separate rule.** `teamMemory` does not look at `privacyClassification`;
  compose it with a policy that does. Promotion refuses `Sensitive` and `Sealed` facts.
- **Erasure is not switched on by it.** Erasure needs one policy to allow it and none to refuse
  it; `teamMemory` abstains. One person's facts, in every scope the eraser can read, are
  `eraseWhere({ label: "author", equals: "<actor>" })`, judged by whichever erase policies you
  install.
- **Who may work on a team's facts.** Anyone who can read a fact can update or invalidate it,
  as with any policy without a `beforeUpdate` rule of its own; `teamMemory` only holds its scope
  and author still, and keeps closing a promoted copy to the people who may withdraw it. Add a
  rule when a team needs more.
