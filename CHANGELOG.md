# Changelog

Notable changes, newest first. Dates are the release date; versions follow
[semantic versioning](https://semver.org). Anything that changes what an
existing caller gets back — even when the old answer was a bug — is called out
under **Behaviour change**, because a version number alone is not a warning.

On npm today: 0.3.0, 0.3.1 and 0.3.3. Numbers marked "never published" were
staged and superseded before anyone could install them.

## 0.4.0 — unreleased

Everything between 0.3.3 and here. It began with one outside bug report (tied
reads returned the oldest facts), which was real; chasing it, and then two
independent reviews of the whole library, found that several of this project's
own headline claims were not true in the code. This release makes them true or
stops making them. 0.3.4 and 0.3.5 were staged and never published — their
changes are here.

### Breaking changes

- **Raw content is immutable.** `updateNode` no longer accepts `content` (in the
  type, and at runtime for JavaScript callers). A correction is a new fact plus
  `validTo` on the old one. Until now the API let a caller overwrite what was
  said, and the conformance suite asserted that the old words vanished.
- **`MemoryStore.listNodes()` is required.** Every node, any validity,
  classification or retention tier, oldest learned first. Third-party backends
  must implement it; it is how export enumerates.
- **Erasure is governed.** On a `govern()` handle, `deleteNode` and `deleteEdge`
  run a new `beforeErase` hook and are refused unless some policy returns `true`
  and none refuses. `personalDefaults` allows the owner; `guardianMode` refuses
  a non-guardian erasing a guardian's fact and otherwise abstains. Previously
  both passed straight through with no policy and no audit.
- **`restoreNode` cannot rewrite a fact.** Over an existing id it may bring newer
  mutable state and a longer anchor trail, but refuses a different provenance,
  content or key reference, and any anchor trail that rewrites or drops recorded
  history. A restored fact must begin with its `created` anchor.
- **Instants must be exact.** A date-time with no zone (local time on whichever
  machine reads it), an impossible calendar date (2026-02-30 used to roll into
  March), or anything that does not parse is refused. A date alone means midnight
  UTC; separators are case-insensitive, as RFC 3339 allows.
- **The MCP exports left the package root.** `governanceTools`,
  `toGovernedFact`, `serverStore` and `attachGovernanceServer` are at
  `al-buddy-memory/mcp`. The root imported the optional `zod`, so installing
  without optional dependencies produced a library that could not be imported.
- `InMemoryStore` refuses an edge or an embedding whose node does not exist, as
  SQLite always did.

### Behaviour changes

- **Tied reads return the newest, not the oldest.** Ordering is one rule shared
  by both stores and hybrid recall: *effective confidence, then most recently
  learned, then node id.* "Learned" is the `created` anchor (exported as
  `learnedAt`), not `validFrom`, which is valid time and deliberately
  backdatable; the id is last because millisecond stamps collide. (Reported from
  outside the project; the diagnosis was exact.)
- **A limited read is the first page of the unlimited one — including when facts
  decay, with or without a query.** SQLite fills its candidate pool by stored
  confidence and ranks by effective; when the pool is full it now widens exactly
  as far as a left-out row could still reach the page. The keyword pool had been
  ordered `rank, confidence` only, so on a common term SQLite handed over the
  oldest 200 hits.
- **Every instant is stored in one canonical spelling** (`Date#toISOString()`:
  UTC, milliseconds, `Z`). "…00Z" and "…00.000Z" are one moment and used to sort
  apart, which reversed the half-open `validAt` boundary; an offset moved one by
  hours. Existing stores have their validity bounds rewritten on open (migration
  v5); anchors written before 0.4.0 are compared as instants rather than rewritten.
- **Paging costs.** Exact paging is not free when facts decay: see README
  "Limits, measured", re-measured for this release (keyword recall 30–50 ms median
  at 100k facts, from 23 ms; filters-only 0.5–1 ms, from 8 ms; 69 MB, from 62).
- **Recall** breaks fused ties on effective, not stored, confidence; settles
  equal vector similarities by effective confidence then recency (they went to
  the smaller id — a 0.3.5 comment claimed otherwise); and skips vectors of a
  different length instead of scoring them NaN into an insertion-order-dependent
  ranking.
- **`consolidate`** replays a night oldest first with the id as the last key, so
  it reads the same sequence on any machine.
- **The governance MCP server governs.** It served the raw store. It now serves
  the owner's `personalDefaults` with the AI client as the audience — a secret an
  agent writes becomes Sensitive and stays out of AI recall — and audits every
  call to `<db>.audit.jsonl`.
- **`exportMemoryMarkdown`** is no longer capped at 10,000 facts, and no longer
  calls itself tamper-evident (nothing detects an edit; it simply never counts).

### Fixed

- **Export was not lossless.** It enumerated through `searchNodes`, whose default
  read hides Archived and PendingDeletion facts — so they were silently dropped,
  the edges pointing at them were kept, and SQLite refused the import halfway.
  Export now uses `listNodes`, and keeps an edge only when both ends are in the
  export (through a filtered view, an edge to a hidden fact disclosed its id).
- **The published JSON Schema rejected valid exports**: it lacked
  `PendingDeletion` and `Conceptual`. The enums are now runtime constants
  (`RETENTION_TIERS`, `RELATIONSHIP_TYPES`, …) the types derive from; a test
  holds the schema to them and validates a real export using every value.
- **A governed update leaked hidden facts.** As a stranger,
  `updateNode(secretId, {})` returned a Sensitive fact's text, and
  `{ privacyClassification: "Private" }` made it readable. A fact an actor cannot
  read is now "not found" to their updates, erasures and links, and the response
  is only what they could see plus what they wrote.
- **Import bypassed governance.** A governed `restoreNode` now runs the write
  policies (a restored secret is classified) and then, over an existing fact,
  the update policies on what will actually be stored. `addEdge`/`restoreEdge`
  refuse endpoints the actor cannot see; `getEdges` omits edges to hidden facts;
  `listNodes` is filtered like any read.
- **The governed handle forwarded the raw store.** `govern()` returned a Proxy
  that passed through every property the inner store had, so as a stranger
  `governed.db.prepare(...)` read a hidden secret and `governed.nodes` was the
  in-memory store's live map. The handle is now a frozen object holding exactly
  the `MemoryStore` methods, every one of them governed.
- **Links and vectors leaked around governance.** `restoreEdge` over an existing
  id replaced the link, so a caller refused an erasure could rewrite it instead:
  a link is now immutable (identical re-import is a no-op, anything else is
  refused). The embedding cache passed straight through, and writing a vector
  onto a hidden fact succeeded while a missing id failed — confirming which
  hidden ids exist. On a governed handle, embeddings now follow their facts'
  visibility and a hidden fact fails exactly like a missing one.
- **SQLite `restoreNode` destroyed dependents**: it deleted and reinserted the
  row, and the cascade took every edge and embedding. It updates in place.
- **`InMemoryStore` handed out live references**, so mutating a returned fact
  rewrote stored history with no anchor or audit. It copies in and out.
- **Half-applied writes.** SQLite `restoreEdge` could delete the edge it was
  replacing and then fail; `deleteNode` could remove the full-text row and not the
  node; `updateNode` read outside the write lock, so two processes could lose a
  change. Each is one transaction now; `updateNode` takes the lock before reading.
- **Concurrent first opens** could leave a valid schema labelled v1 for ever:
  the migration runner now reads `user_version` inside the lock.

### Docs that claimed more than the code did

- "There is no delete" (ENFORCEMENT.md), "nothing is deleted" (README,
  GOVERNANCE.md): replaced with what is true — invalidation, immutable content,
  governed and audited erasure.
- "A `validAt` query reconstructs any past state": it answers what was true at X,
  not what the store believed at X; the README now says which.
- The data-stewardship and schema-evolution policies made JSON-LD, RDF/Turtle,
  SHACL and a schema registry "mandatory". None exist. Each document now opens
  with what the library implements, and those sections are marked as targets.
- "Every governed decision is recorded" now says when: only with an audit sink,
  written after the store call succeeds.
- The conformance scorer said it counted confidences "in [0,1]" and checked only
  that the value was a number; it checks the bounds now. SCORING.md says what the
  round-trip dimension can prove (the artifact survives) and what it cannot (a
  fact the original export left out).
- The README states plainly that provenance is asserted by the writer (immutable,
  not verified), that `encryptionKeyRef` does not encrypt anything, and that the
  governed handle — not the inner store — is what you hand out.

### Internal

- `npm run check` (typecheck, tests, browser bundle) is the one gate, and both
  CI workflows run it.
- Migrations v4 (a covering index for the new order) and v5 (canonical
  instants); both run on open.
- A test walks every static import reachable from the package root and fails on
  any optional dependency.

## 0.3.3 — 2026-09-14

- An undo of a consolidation pass records that it was an undo, by whom, and why.
- Prior art credited in the README.

## 0.3.2 — never published

Staged and never approved; these changes shipped in 0.3.3.

- Scoped hybrid recall: type, tags, confidence and privacy/retention scope apply
  to the vector list as well as the keyword list, so a scoped recall cannot pull
  an out-of-scope fact in through the vector side.
- The tag filter applies before the limit, not after it.
- Review and undo a consolidation pass.

## 0.3.1 — 2026-09-10

- `bin` paths in the form npm accepts.
- First release through staged trusted publishing (OIDC + provenance); a
  maintainer approves each one with 2FA before it goes public.

## 0.3.0 — 2026-09-10

- Governance enforced rather than implied: policy hooks, immutable provenance.
- Limits measured at 100k facts and published.
- Conformance CLI, browser demo, and the governance MCP server.

## 0.2.0 — 2026-09-10

- The spec, the portable export format and its JSON Schema, published and
  versioned.
