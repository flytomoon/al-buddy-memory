# Data boundaries: mapping your own rules

Most organisations already have a rule for who may see what: a team sees its own work, people
on an account see that account, a few things are for everyone. A data boundary is that rule
written as data, so the store can apply it **inside the query**: SQLite and Postgres filter on
it in the same `WHERE` as everything else, before ranking and before any `limit`. Facts outside
the boundary never take a place in a page, and never change what the actor gets back, in what
order, or how many. The example policy is [boundaries.ts](boundaries.ts).

The API knows two things and nothing more:

- **Labels**: the keys of a fact's `contextualMetadata`. You choose them: `team`, `client`,
  `region`, `matter`, `cohort`, anything.
- **Actor attributes**: what your application knows about whoever is asking, handed in with the
  context, taken from your own login or directory:

```ts
const inner = new PostgresMemoryStore({ connectionString, tenantId }); // or SqliteMemoryStore
const store = govern(inner, {
  policies: [boundaries],
  context: () => ({ actor: user.id, attributes: { teams: user.teams, clients: user.clients, roles: user.roles } }),
  audit: storeAudit(inner),
});
```

## Writing the rule

A `readBoundary` is built from four shapes, and nothing else:

| Shape | Means |
|---|---|
| `{ label: "team", equals: "ops" }` | the fact's `team` is `"ops"` |
| `{ label: "team", in: ["ops", "web"] }` | the fact's `team` is one of these |
| `{ label: "team", in: { actor: "teams" } }` | the fact's `team` is one of the actor's `teams` (`equals: { actor: "client" }` reads the same way) |
| `{ all: [...] }` / `{ any: [...] }` | AND / OR |

A label may hold one string or an array of strings: a fact labelled `team: ["ops", "web"]`
belongs to both teams. The example company's rule, "a fact is for the whole company, or for
someone on its team AND its client":

```ts
readBoundary: {
  any: [
    { label: "visibility", equals: "company" },
    { all: [{ label: "team", in: { actor: "teams" } }, { label: "client", in: { actor: "clients" } }] },
  ],
},
```

## What to know

- **It fails closed.** There is no NOT, so a fact can only be admitted by a label it carries. A
  fact with no `team`, or an actor with no `teams` attribute, matches nothing. Label facts when
  they are written: the example's `beforeWrite` gives an unlabelled fact the writer's first team.
- **`beforeRead` still has the final word.** It runs on what the boundary lets through, and can
  hide or redact any of it. The example redacts billing rates for anyone outside finance. A rule
  that needs more than labels and attributes (dates, arithmetic, a lookup) belongs there.
- **Every read, not only search.** `getNode`, `listNodes`, edges, embeddings, history and
  export apply the same boundary, and a fact outside it is "not found" to updates, erasures and
  links. Several policies' boundaries all apply. A caller may pass its own `labels` filter to
  `searchNodes` to narrow a search; it cannot widen the boundary.
- **No policy, no change.** A policy without `readBoundary` behaves exactly as before.
- **Labels are written by whoever writes the fact.** A boundary decides who reads; deciding who
  may label a fact for which team is a `beforeWrite` rule, and the example does not make one.
