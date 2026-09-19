# Changelog

Notable changes, newest first. Dates are the release date; versions follow
[semantic versioning](https://semver.org). Anything that changes what an
existing caller gets back — even when the old answer was a bug — is called out
under **Behaviour change**, because a version number alone is not a warning.

On npm today: 0.3.0, 0.3.1 and 0.3.3. Numbers marked "never published" were
staged and superseded before anyone could install them.

## Unreleased

Six fixes to the **MCP surface** — the only surface most people will ever touch.
No schema change, no architecture change. Full write-ups, with the measurements,
are in [docs/RESILIENCE-LEDGER.md](docs/RESILIENCE-LEDGER.md).

### Behaviour change

- **`recall` now returns two content blocks on the first call of a connection.**
  The first is the pinned tier — the person's standing rules — and the second is
  the JSON array of facts, unchanged. Every later call returns the array alone, as
  before. A client reading `content[0]` as the facts will need `content[content.length - 1]`
  on the first call. The tier exists to be in every prompt and the server surfaced
  it nowhere; the handshake `instructions` had no room to explain a seventh tool.
- **`remember` returns a new field, `mayConflictWith`.** Up to three *current*
  facts that read like the one just stored, each `{id, text, validFrom}`, so the
  client can call `invalidate` on the ones that stopped being true. Nothing is
  retired automatically. Invalidate-never-overwrite depended on a call nothing ever
  asked for: "I live in Tokyo" then "I moved to Berlin" left both facts current.
- **`recall` and `remember` results carry `origin` and `retiredBy`** — which
  assistant wrote a fact, and which closed it. Both `null` when the host knew
  nothing. `origin` was stored from 0.4.1 and never surfaced; `invalidate` and
  `unpin` recorded nothing about who called them at all.
- **`pin` text is collapsed to one line before it is stored.** A pin containing
  newlines rendered as several pins, with forged labels and markdown headings, and
  the block header asserted all of it was "always true". The header now frames the
  tier as stored data rather than instructions, matching `renderMemoryBlock`.
- **`remember.text` is capped at 4,000 characters and `pin.text` at 500** on the
  MCP surface. Both were unbounded: a 10 MB "fact" was indexed and returned in full
  on every matching recall. A host calling `governanceTools` directly is unaffected.

### Fixed

- **docs/STARTER.md consolidated through the raw store**, one step after building a
  governed handle — so every nightly-derived fact skipped policy and audit.
  Measured: a derived fact restating a password is written `Private` with 0 audit
  events through the raw store, `Sensitive` with 8 through the governed handle.
- **The README blamed the brute-force scan for the semantic path's cost.** It is
  not the cost. At 100,000 facts the scan is 85–127 ms; the SQL read (978–1,182 ms)
  and `JSON.parse` (1,418–1,744 ms) of 8,003-byte text rows are 95–96% of the work.
  So BLOB storage is the move and `sqlite-vec` buys little at this size — both
  stated as projections, since neither is built.
- **README: "Backups, restores and synced folders."** Restoring a backup without
  first stopping the server and deleting `-wal`/`-shm` replays the WAL over the
  restore and silently does nothing (reproduced). Never put the database in iCloud,
  Dropbox, OneDrive or Google Drive.

### Added

- `PINNED_HEADER`, `knownOrigin` and `readOrigin` are exported from the package root.

## 0.4.1 — 2026-09-15

### Added

- **The MCP server tells every client how to use it.** It sends `instructions` at
  connection: recall at the start of a conversation and when a known person,
  project or preference comes up; remember durable facts in one plain sentence;
  never remember secrets, small talk or one-off requests; invalidate what stops
  being true. (Claude Desktop connected to the 0.4.0 server five times and never
  called a tool — a client that isn't told when to use memory doesn't.)

  **Corrected 2026-09-18** — this entry originally read "the essentials fit in the
  first 512 characters, which some clients truncate to." Measured, the string is
  **637 characters**, and character 512 lands mid-sentence at "When a fact". What
  is inside the budget is the recall rule and the remember rule — the two that
  decide whether the memory is used at all. What falls outside it is the
  invalidate rule and the pin rule, so a client that truncates at 512 gets a
  memory it will read from and write to, but not retire from. The claim is left
  here rather than removed, per `docs/RESILIENCE-LEDGER.md`; shortening the string
  to fit is open, and tracked in that file's section C.
- **Every fact written through the MCP server records which app wrote it:**
  `contextualMetadata.origin = { app, appVersion, via: "mcp" }`, taken from the
  connection handshake rather than from anything the model says. `remember` and
  `pin` stamp it; `GovernanceDeps.origin` lets another host supply its own
  (`agent`, `channel`, `model`). `withOrigin` and the `Origin` type are exported;
  `modelClaimed` is reserved for a model's self-report, kept apart from `model`
  because nothing verifies it. A first-class, immutable origin field in the spec
  and portable format is planned for 0.5.

## 0.4.0 — 2026-09-15

Everything between 0.3.3 and here. It began with one outside bug report (tied
reads returned the oldest facts), which was real; chasing it, and then two
independent reviews of the whole library, found that several of this project's
own headline claims were not true in the code. This release makes them true or
stops making them. 0.3.4 and 0.3.5 were staged and never published — their
changes are here.

### Added

- **A tamper-evident audit log.** `ChainedAudit` writes each governance event with
  the hash of the one before it (HMAC-SHA256 with a key); `verifyAuditChain` and
  `al-buddy-memory verify-audit` name the first edited, removed, inserted or
  reordered line. A cut-off tail, or a rewrite by whoever holds the key, is
  caught only against a head hash published elsewhere — the docs say so, and that
  a keyless chain catches accidents, not a deliberate rewrite. A log that cannot be
  extended (an old-format file, a crash-torn last line) is refused with the reason;
  the MCP server checks at start instead of failing after a write. The shipped MCP
  server writes a chained log, keyed by `AL_BUDDY_MEMORY_AUDIT_KEY`.

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
- **`InMemoryStore` matches a query the way SQLite does:** any of its words, whole
  words, case-insensitive, ranked by word rarity among the matches — except that
  SQLite's FTS also folds diacritics and some Unicode case ("cafe" finds "café"),
  which the in-memory store does not. It used to match
  the whole query as one substring, so a question found nothing that SQLite found;
  partial words ("tok" for "Tokyo") no longer match, as they never did in SQLite.
- **Weights are validated.** A confidence outside [0,1], or a negative or
  non-finite decay rate, is refused on every write path — imports included, so an
  older export holding such a value fails at that node. (Exact paging relies on
  effective confidence never exceeding stored; a negative confidence broke it.)
- **`personalDefaults` is stricter.** Only the owner's actor changes a fact; export
  and erasure of Sensitive facts, and erasure of anything, need the owner in
  person (no other audience) — as reads already did.
- **`exportView` is read-only.** Its write methods refuse; it used to delete.

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
- **Governed reads let hidden facts take places on the page.** Filtering came
  after the store's limit, so as an AI audience `recall("password", limit 1)`
  returned nothing while `limit 50` found the visible fact — any word could be
  probed for secrets containing it. The governed read now fills the page with
  facts the actor may see; a cursor the actor cannot see behaves as a missing one.
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

### Also fixed before release — Astra's final review

- A governed call copies its arguments at the moment it is made. The checks
  await, so a caller in the same process could pass a visible id, clear the
  check, and swap in a hidden one before the write.
- A stranger's import answered differently for a hidden id (refused) than a
  missing one (created). `personalDefaults` now allows import by the owner only,
  and a governed import runs its authorisation before anything depends on
  whether the fact exists.
- Stores whose creation times were written by 0.3.3's `restoreNode` with offsets
  ("…-01:00") sorted by the sign character, not by time, so SQL and JavaScript
  disagreed about a page. Migration v5 makes the stored sort key canonical (the
  anchors stay verbatim); JavaScript orders by the instant; the final id tie-break
  is byte order in both. The paging bound now includes the id, so 100,000 facts
  sharing one creation instant no longer force a full read (324 ms → 3 ms).
- The chained audit log verifies itself under its key before extending, requires
  a complete final line, treats only a missing file as new, and writes nothing
  more after an append that failed part-way. `verifyAuditChain` names a `null`
  record and reports physical line numbers.

- **Hidden facts could reorder visible keyword results** (Astra; founder's call,
  "fix it"). BM25 weighs words by rarity across every fact, hidden ones included,
  so through the MCP server an AI could test whether hidden facts contain a word by
  comparing the order of two visible results. A governed keyword search now reads
  every match, keeps the visible ones, and ranks them with word rarity counted
  over those visible matches alone, then effective confidence, then recency. (A
  first version used plain per-fact term frequency and lost natural questions to
  facts dense in "the / is / my" — Fable caught it; a recall-quality test now
  holds twelve plain-question targets on the first page.) It is slower on a large
  store (README "Limits, measured"); the raw store's ranking and speed are unchanged.

### Known issues

- `searchNodes({ after })` means different things in the two stores (SQLite: facts
  learned after the cursor; in-memory and governed keyword search: the rest of the
  ordered listing) and no conformance test covers it. It is unused by the library
  and unreachable from the MCP server; define it or remove it before 1.0.
- Timestamps are read as instants only in ISO 8601 extended form with a zone (or a
  bare date). A legacy value spelled otherwise — a basic offset ("+0100"), a space
  instead of "T", a year alone — sorts as having no creation instant (oldest). SQL
  and JS agree about it; the stored anchor is untouched.
- A governed read that steps past many hidden facts takes measurably longer: a
  timing hint, never content (GOVERNANCE.md).
- Governed keyword search ranks by visible-only word rarity rather than the raw
  store's BM25, so the same query can order results differently through a governed
  handle.
- `HybridRetriever` caches the vector list for 60 s per model, not per actor: one
  retriever shared by two actors of a governed store can serve one actor's visible
  list to the other. Use one retriever per actor.
- With an embedder, MCP `recall({ includeSuperseded: true })` returns current facts
  only (the hybrid path pins `validAt` to now); the shipped server has no embedder.

### Internal

- `npm run check` (typecheck, tests, browser bundle) is the one gate, and both
  CI workflows run it.
- Migrations v4 (a covering index for the new order) and v5 (canonical instants,
  computed in JavaScript by the same parser the ranking uses); both run on open.
  A creation time with no instant to find sorts as the oldest fact in SQL and JS
  alike.
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
