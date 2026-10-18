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

Sharing a fact with a team or the company is a **promotion**: a new fact at the target scope,
holding the text its author approved, with the consent in the audit trail, the original
untouched. Promotion is not in this release. Until it is, a fact reaches a `team:` or `org`
scope only through an import by one of `importers` (or through the raw store, which no policy
governs).

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
  compose it with a policy that does. Promotion will refuse `Sensitive` and `Sealed` facts.
- **Erasure is not switched on by it.** Erasure needs one policy to allow it and none to refuse
  it; `teamMemory` abstains. One person's facts, in every scope the eraser can read, are
  `eraseWhere({ label: "author", equals: "<actor>" })`, judged by whichever erase policies you
  install.
- **Who may work on a team's facts.** Anyone who can read a fact can update or invalidate it,
  as with any policy without a `beforeUpdate` rule of its own; `teamMemory` only holds its scope
  and author still. Add a rule when a team needs more.
