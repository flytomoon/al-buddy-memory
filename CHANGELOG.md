# Changelog

Notable changes, newest first. Dates are the release date; versions follow
[semantic versioning](https://semver.org). Anything that changes what an
existing caller gets back — even when the old answer was a bug — is called out
under **Behaviour change**, because a version number alone is not a warning.

Every version from 0.3.0 on is on npm unless it is marked "never published":
those were staged and superseded before anyone could install them. 0.2.0 and
earlier were GitHub releases only.

## 0.11.0 — unreleased

### Added

- **Sign-in with your identity provider.** `startHttpConnector({ oidc, deps })` accepts OIDC/JWT
  bearer tokens from a configured issuer instead of the owner's passphrase: the signature is
  checked against the issuer's JWKS (from `jwksUri`, discovery, or a given key set), and `iss`,
  `aud`, `exp` and `nbf` with jose (new optional dependency). `oidc.claims` maps claims onto the
  actor attributes a `readBoundary` reads, `tenantClaim` names the tenant and `actorClaim` the
  actor (default `sub`); `deps(who)` gives each verified person their governed store. Any failed
  check is a 401 that never reaches `deps`. The server is now importable as
  `al-buddy-memory/http`. The owner's passphrase server and `al-buddy-memory-http` are unchanged.
  Okta, Microsoft Entra and Google Workspace examples: `docs/SIGN-IN.md`.
- **Data boundaries.** A policy may declare its read rule as data: `readBoundary`, a filter over
  fact labels (keys of `contextualMetadata`) and the asking actor's new optional `attributes`,
  with equality, membership, AND and OR only. The governed handle resolves it per actor and sends
  it into the store's query as the new `labels` option of `searchNodes` (and Postgres's
  `searchSimilar`), where SQLite and Postgres compile it into the `WHERE`, before ranking and any
  `limit`. Every other read applies the same rule, and `beforeRead` runs afterwards with the final
  word. A policy without one behaves exactly as before. An example policy and how to map an
  organisation's own rules: `docs/policies/boundaries.md`. `matchesLabels` and the `LabelFilter`,
  `ReadBoundary` and `ActorAttribute` types are exported.
- **Erasure by label, with a receipt.** `eraseWhere(selector)` on every governed handle erases
  every fact the actor can see whose labels match (the boundary language, literal values only).
  Each goes through the same path as `deleteNode`: the erase policies judge it and its conclusions
  as one decision, a memory lock refuses, and Recently deleted holds. It returns an
  `ErasureReceipt` (selector, actor, time, counts erased / refused with reasons / held in Recently
  deleted, every id hashed, and what it does not reach: backups, earlier exports, facts the actor
  cannot see). The receipt's digest is recorded in the audit trail as one event.
  `verifyErasureReceipt` and `al-buddy-memory verify-audit … --receipt receipt.json` check it.
  It needs an audit sink. The receipts are equal on SQLite, Postgres and in-memory.
  `docs/ERASURE.md`.
- **Checking a chain from an open store.** `SqliteMemoryStore.verifyAudit()` and
  `PostgresMemoryStore.verifyAudit()` (read-only; a missing tenant is reported, never created),
  and `al-buddy-memory verify-audit --postgres --tenant <key>` with `DATABASE_URL`.
  `AuditEvent` gains an optional `receipt` field, and the verifiers an optional `visit` callback.
- **README: an Enterprise section** covering Postgres, boundaries, encryption at rest (the
  database's KMS on Postgres; full-disk encryption or a SQLCipher build locally, which is not
  built here) and erasure.

### Changed

- **Postgres writes no longer grow with the tenant.** A write on `PostgresMemoryStore` used to
  rebuild the tenant's whole graph (about 640 ms a write at 20,000 facts in PGlite). It now reads
  only the rows it acts on — the fact and its versions, the conclusions an invalidation or erasure
  reaches, the edges it touches — and persists what changed, in the same single transaction under
  the tenant lock: 1–3 ms a write from 1,000 to 100,000 facts. `initialize()` adds the indexes this
  uses; run it once after upgrading. The audit append walks the tenant's chain once per store
  object, as SQLite does, and checks every append's tail against the tenant row, instead of
  walking the whole chain on every write. `listNodes` reads facts only. The governed cascade asks
  a store that can (`nodesRestingOn`) for a fact's conclusions instead of listing every fact.
  Benchmark: `bench/postgres-writes/run.mjs`; numbers in `docs/POSTGRES.md`.

### Behaviour change

- **A governed keyword search no longer finds a fact by a word a policy redacted.** The store
  matches stored words; a fact whose visible text holds none of the query's words is now dropped
  from the result and from the word weights. It used to come back (redacted), which told the actor
  it held the word, and it could move the order of the other results.
- **Nor by a label or tag a policy redacted** (security review 2026-10). A `labels` or `tags`
  filter on a governed `searchNodes` is now met by the fact as the actor sees it, and
  `eraseWhere` selects (and counts) only facts whose matching labels the actor can see. A filter
  on a label a `beforeRead` policy strips used to return the fact, confirming the stripped value.
  Facts the policies pass unchanged match exactly as before.
- **OIDC sign-in refuses plain-http key sources and an unbounded clock tolerance.** `issuer` (when
  discovered), `jwksUri` and a discovered `jwks_uri` must be https, except to this machine;
  `clockToleranceSeconds` must be 0 to 300. Both used to be accepted, and whoever answered an http
  key fetch could sign tokens.

### Security

- **The connector's sign-in only sends codes to Claude, ChatGPT or this machine** (security review
  2026-10-08). Registering an app whose redirect is anywhere else is refused, a client registered
  earlier is held to the same list at sign-in, and the consent page says where access goes.
  `allowedRedirectOrigins` (or `AL_BUDDY_MEMORY_REDIRECT_ORIGINS`) sets the list.

- **Security review of the enterprise surface** (Postgres store, data boundaries, erasure
  receipts, incremental writes, OIDC sign-in): `docs/SECURITY-REVIEW-2026-10.md` lists what was
  checked, found and fixed, and what was not covered. Besides the two behaviour changes above, an
  erase or an invalidation refused because of a conclusion the actor cannot see no longer names
  that conclusion or the policy's reason about it, in the error or in an erasure receipt, and
  `docs/SIGN-IN.md`'s example now refuses tenants the server does not serve.
- **A stranger's wrong passphrases no longer lock the owner out of the connector** (review
  2026-10-08, M3). Five from one app lock that app for 15 minutes; twenty from all apps within
  15 minutes still lock every app, so registering fresh apps buys no extra guesses. Each lock
  writes one line to the connector log (the app's name, which lock, until when). It used to be
  one counter: five wrong passphrases from anyone locked the page for everyone, silently.
- **Dependency advisories.** The optional `@modelcontextprotocol/sdk` now needs `^1.32.1` (was
  `^1.30.0`; GHSA-6qxp-vccf-f47h, its OAuth client could send credentials to an authorisation
  server the MCP server chose). The lockfile moves `proxy-addr` to 2.0.8 (GHSA-jqcg-44mw-7w3h,
  under the HTTP connector's express), `sharp` to 0.35.5 (GHSA-wq5f-xc86-pv6w, under the
  on-device embedder), and `ip-address`, `fast-uri` and `source-map-js` to their fixed patches.
  Still reported, dev-only: `sprintf-js` under `@mastra/core`'s `gray-matter` (no fixed version
  exists) and a low `esbuild` advisory for its Windows dev server, which the build does not run.

## 0.10.1 — 2026-10-03

The servers keep answering while they index, the Claude Code plugin gets its own name and slash
commands, and `al-buddy-memory status`.

### Fixed

- **A server answered slowly for the first seconds to minutes after start** while it embedded an
  existing memory: loading the on-device model and embedding with it are synchronous native work,
  and the background pass ran them on the event loop. On a 5,000-fact database the HTTP connector's
  `/health` took 36 ms at p50, 85 ms at p95 and up to 268 ms during the pass (1.4 ms otherwise), and
  seconds on a larger real one. Now the shipped servers run the model in a worker thread
  (`WorkerEmbedder`, same model tag, so existing vectors stay valid), and `indexMissingEmbeddings`
  gives the loop back between batches and after every `sliceMs` (default 20) of writes: the same
  pass measured 0.8 ms p50 and 1.5 ms p95. Model loading no longer stalls requests either.

### Added

- **`al-buddy-memory status [--json]`**: current, retired and pinned fact counts, the database path
  and size, the last write, and whether semantic search can run here (switched off, Intel Mac,
  runtime missing, model not downloaded yet, or on — with how many facts are indexed). Counts only;
  never creates the database.
- `WorkerEmbedder` (exported): LocalEmbedder's model in a worker thread.
- **Claude desktop app extension** (`al-buddy-memory.mcpb`, macOS): `npm run build:mcpb` bundles the
  stdio server with its dependencies (MCP Bundle format), including better-sqlite3 compiled for
  Claude Desktop's built-in Node (Electron 44, ABI 149) and the published builds for Node 22–26,
  and the on-device model runtime for Apple silicon. Same database as the plugin by default. The
  release workflow attaches it to the GitHub release.
- **Claude Code plugin**: slash commands `/al-buddy:forget`, `/al-buddy:status`, `/al-buddy:export`,
  `/al-buddy:import` and `/al-buddy:help`; the two skills take arguments as
  `/al-buddy:recall <question>` and `/al-buddy:remember <fact>`. A getting-started guide
  ([docs/claude-plugin.md](docs/claude-plugin.md), also albuddy.com/claude.html) and a privacy
  statement ([docs/PRIVACY.md](docs/PRIVACY.md)).

### Behaviour change

- **The plugin is now `al-buddy`** (it was `al-buddy-memory`), so its commands read `/al-buddy:…`
  and it installs as `/plugin install al-buddy@al-buddy`. Its MCP server is
  `plugin:al-buddy:memory`, so tool permission rules name `mcp__plugin_al-buddy_memory__…`. The
  memory file is unchanged.

## 0.10.0 — 2026-10-03

The shipped servers recall the way the benchmark does, memory exports from the server and the
command line, and the package installs as a Claude Code plugin.

### Behaviour change

- **The MCP servers' recall is hybrid by default.** `al-buddy-memory-mcp` and
  `al-buddy-memory-http` load the on-device embedder (`@huggingface/transformers`, already an
  optional dependency, so `npx` installs it) in the background and switch recall from keyword-only
  to keyword + vector as soon as it answers a probe. They never wait for it: until it loads, and
  wherever it cannot (the optional dependency missing, no onnxruntime binary for the platform —
  Intel Macs among them — or no network on first run), recall stays keyword-only and stderr says
  so once, with the reason. A recall or an embed that fails mid-session falls back to keyword for
  that call and turns the embedder off. `AL_BUDDY_MEMORY_SEMANTIC=off` keeps 0.9.0's keyword-only
  recall and never downloads the model. The model is about 90 MB, downloaded once from the Hugging
  Face hub to `~/.al-buddy-memory/models` (`AL_BUDDY_MEMORY_MODEL_CACHE`), not into npx's
  throwaway install folder, so a new version does not download it again.
- **Hybrid recall in the MCP tools reads time and counting cues** (`expand`), the setting the
  LongMemEval result was measured with: "latest", "first", "in April", "how many" now order and
  widen what `recall` returns. It only adds candidates; the question is still searched as before.
  `governanceTools({ expand: false })` turns it off. Keyword-only recall is unchanged.
- A failed embedding no longer fails `remember`: the fact is stored, stays findable by keyword,
  and is embedded by the next start's backfill.

### Added

- Facts written without a vector (by keyword-only runs, or other hosts) are embedded in the
  background when a server starts, at most 5,000 per start (`AL_BUDDY_MEMORY_INDEX_LIMIT`; 0
  skips it). `indexMissingEmbeddings(store, embedder, batchSize, { limit })` takes the bound.
- `startSemanticRecall` (from `al-buddy-memory/mcp`): the load-in-background, fall-back-to-keyword
  wiring the servers use, for hosts that build their own. `governanceTools({ embedder })` also takes
  a function, asked at every call, and `onEmbedderFailure`.
- `LocalEmbedder({ cacheDir })`: where the model is kept. Without it, transformers.js's default
  as before.
- **`export` MCP tool.** The memory in the portable format, as the policy lets it leave: through
  `serverExportView`, `beforeExport` decides, so an assistant can export what it could recall and
  nothing Sensitive or Sealed. Up to 50,000 bytes come back inline; a bigger export needs a path,
  which must be absolute, end in `.json`, and not exist (it never overwrites; written 0600). Only
  the stdio server writes files (`exportToFiles`); the remote connector answers inline only.
- **`al-buddy-memory export [--out file] [--format portable|markdown] [--db path]`**: the owner's
  complete backup (Sensitive and Sealed included, through an owner `exportView`, audited), to
  stdout or a new file. **`al-buddy-memory import <file> [--db path]`**: restores a portable export
  as the owner, every check before the first write, idempotent.
- **`al-buddy-memory context [--hook] [--max-chars N]`**: a bounded session-start briefing — the
  pinned rules, current facts that mention the working directory's name, and the most recently
  learned facts — read with the assistant as the audience, so nothing recall would hide. Empty
  (and nothing created) when there is no memory yet.
- **Claude Code plugin** (`plugin/`, and `.claude-plugin/marketplace.json` at the root):
  `/plugin marketplace add flytomoon/al-buddy-memory`, then
  `/plugin install al-buddy-memory@al-buddy`. It starts the MCP server with `npx` pinned to an
  exact version, adds `recall` and `remember` skills, and a SessionStart hook that runs
  `context`. `npm run release:pin` now moves the plugin's pins with the README's.
- **MCP Registry entry.** `server.json` describes the stdio server for the
  [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.flytomoon/al-buddy-memory`,
  and `package.json` carries the matching `mcpName` the registry checks on npm. `npm run release`
  moves `server.json` to each new version.
- `al-buddy-memory mcp` starts the stdio MCP server, the same as `al-buddy-memory-mcp`, so
  `npx -y al-buddy-memory mcp` works without `--package=` — the form a registry listing runs.
- LongMemEval harness, speed beside every score: each question's `recall` call is timed (wall
  clock and CPU, with the machine's load average) and the summary gives p50/p95/max; memory
  building and recall run one question at a time so a recall is never timed while another
  question works in the same process, and the question is always embedded afresh. `--rerank-depth`
  reranks only the best N candidates. `recall-sweep.mjs` times several reranker settings over one
  memory build per question, with no model calls, and says what each would show the reader.
  `compare.mjs` shows recall times and counts the questions whose reader saw the same rounds.
- `bench/longmemeval/regrade-openai.mjs`: re-grades with the official gpt-4o judge; the official judge prompts now live in `judge-prompts.mjs`, shared with the Codex re-grade.
- Benchmark results: the full 500-question LongMemEval run without the reranker (92.6% overall, recall p50 11.7 ms / p95 33.5 ms), side by side with the all-levers run, in `bench/results/`.

## 0.9.0 — 2026-10-01

### Added

- **Remote connector.** `al-buddy-memory-http` serves the governance server's tools over
  Streamable HTTP for one owner, so Claude and ChatGPT can reach the same memory as a remote
  connector. Sign-in is OAuth 2.1 through the MCP SDK's own handlers (discovery, dynamic client
  registration, authorize, token, revoke) behind a passphrase consent page; only hashes of codes
  and tokens are stored, refresh tokens rotate, and five wrong passphrases lock the page.
- Every governance tool now declares `title`, `readOnlyHint`, `destructiveHint` and
  `openWorldHint`, as both assistant directories require.
- **Reranking.** `new HybridRetriever(store, embedder, { reranker })` rereads the question with each
  fused candidate through a cross-encoder and returns them in its order; `rerank: false` skips it
  for one recall, `rerankDepth` bounds how many it reads (default the larger of the limit and 50).
  `LocalReranker` runs one on-device through transformers.js — `Xenova/ms-marco-MiniLM-L-6-v2` by
  default, `Xenova/bge-reranker-base` or any cross-encoder by name — downloaded once to the same
  cache as the embedder, loaded only when first used. Long memories are scored in 1,000-character
  windows (`passageWindows`); a memory scores its best window. `FakeReranker` for tests.
- **Time- and count-aware recall.** `recall(query, { expand: true | { now } })` reads the query with
  `analyzeQuery` (rules, no model call): a period it names ("in April", "the past two weeks", "last
  Thursday", "from July to October"), resolved against `now`, favours facts whose `validFrom` falls
  in it and is taken out of the search words; a question that counts or compares across memories
  ("how many", "total", "A and B", "which came first") searches each thing it names, from a deeper
  pool; a question longer than the keyword search reads is also searched by its content words, so
  its last words count; "currently" and "initially" nudge the latest and earliest facts up. The
  question itself is always searched as plain recall searches it, so `expand` only adds; facts
  outside a period are never dropped.
- `recall(query, { candidates })`: how many candidates each keyword and vector list contributes
  before fusion (default 50, as before), so a reranker can be given more to choose from.
- None of these writes anything or changes a fact: scores, sub-queries and periods live for one
  recall. Recall without them is unchanged.
- LongMemEval harness: `--rerank`, `--expand`, `--recall-pool`, `--aggregate-top-k` (more rounds
  for counting questions only), `--chain-of-note` (a reader
  prompt for counting questions that is not an official template, and is recorded as such), a
  shown-evidence diagnostic beside the official retrieval metrics, `compare.mjs` for A/B runs, and
  `--types` now refuses a type that does not exist.


## 0.8.3 — 2026-09-26

### Changed

- **Recall reads vectors as views.** Stores that keep float32 vectors (SQLite since 0.8.1) now hand
  the scan a read-only numeric view instead of building an array per vector (optional
  `listEmbeddingVectors`, governed like `listEmbeddings`). On a copy of a real 7,357-memory store
  the first lookup went from 103 ms to 50 ms, with identical results.
- **The keyword index keeps no copy of the text** (schema v10, contentless FTS5 with deletes).
  SQLite stored every memory's text a second time inside the index; search only ever reads the
  rowid and the rank. Same store: 64 MB → 42 MB after `compact()`. A redundant embeddings index
  is dropped with it.
- Proven with `compareStores` on that copy before release: every memory, edge and history row
  identical, and 36 of 36 lookups (meaning and keyword) returned the same top 10.

## 0.8.2 — 2026-09-26

### Added

- **The gauge.** `gaugeStore(path, { embedder })` measures a store file read-only: size and bytes
  per memory, bytes per vector and any vectors still stored as JSON, history and audit rows,
  memories not yet indexed for meaning search, current states, first-lookup and repeated-lookup
  times (median and 95th percentile) and keyword-lookup times. `checkBudgets(result)` returns each
  number over its budget with the reason it matters. A 3,000-memory store is held inside the
  default budgets in the test suite.
- **The no-loss gate.** `compareStores(before, after, { queries, embedder })` checks that a changed
  copy of a store holds exactly the same memories, edges and history, and returns the same top-10
  results for the same lookups — the check to run before any storage or search change ships.

### Changed

- `bench/bench-vectors.mjs` measures float32 vectors, as an on-device model produces them; README
  "Limits, measured" carries the 0.8.1 numbers.

## 0.8.1 — 2026-09-25

### Changed

- **Vectors are stored as float32 bytes**, not JSON text. Measured on a real 6,819-vector store:
  the embeddings column shrinks from 55 MB to 10.5 MB, and loading it for a recall no longer parses
  text — 3 ms instead of 190–270 ms. A vector that 32 bits cannot hold exactly stays JSON, so no
  recall result changes. Existing stores are converted on open (schema v9); `compact()` returns the
  freed space to the disk when nothing else has the file open.

## 0.8.0 — 2026-09-25

### Added

- **Current state.** `recordState(store, { subject, aspect?, text, at?, aliases? })` records "where
  X stands now" as one live memory per subject and aspect. A newer state closes the one it replaces
  (`validTo`, `supersededBy`), kept as history; a state that arrives late is stored already closed
  and never overturns a newer one; repeating the current state is a no-op; ordinary facts are never
  touched. `currentStates` lists what is current (at any instant), `stateHistory` shows what a
  subject has been, and `statesMentionedIn(states, text)` finds the states a question is about, by
  subject or alias as whole words. `replaces` closes live states filed under another name that the
  caller (usually a model shown the subject's states) says the new one replaces, and
  `supersedeState` closes a duplicate found later. SPEC §8d.
- **`freshness` on recall.** A weight (default 0, off) that fuses a recency ranking with the keyword
  and vector lists, so the newest of several matching notes comes first. It only reorders facts the
  query matched.

### Changed

- npm keywords name the frameworks it plugs into (ai-sdk, langchain, langgraph, mastra) and what it
  is (agent-memory, long-term-memory, mcp-server).

## 0.7.0 — 2026-09-24

### Added

- **Mental models.** A standing question ("what does the user care about when choosing tools?")
  with a pre-written answer kept current in the background, so reading it costs no model call.
  `defineMentalModel(store, { question, scope })` defines one; `refreshMentalModels(store,
  { propose })` asks one batched judgement about every stale model and writes each answer as a new
  conclusion node that quotes the facts it rests on (checked verbatim; an unsupported answer is
  refused and the previous one stays); `getMentalModel` / `listMentalModels` read the answer, its
  freshness and its evidence; `mentalModelHistory` / `mentalModelAsOf` show every earlier answer and
  what the model said on a given date; `deleteMentalModel` removes one. A model reads as stale when
  a fact it rests on stops being true (its answer is retracted, kept) or is erased (its answer is
  erased with it — an erased fact cannot survive in a summary), or when facts in its scope arrive
  that its answer was never shown. An answer is as restricted as its most restricted source; Sealed
  facts are never shown to the judgement; Sensitive ones only with `includeSensitive`. SPEC §8c.
- MCP tools `mental_model` (read one, or list) and `define_mental_model`. Answers are refreshed by
  the host on its own schedule.
- **Framework integrations**, as subpath exports with the frameworks as optional peer dependencies
  (nothing loads unless you import the subpath). Each is a thin shape over the same governed tools
  the MCP server uses, so a write from a framework is the same policy-checked, provenance-stamped
  write, with `origin.agent` set to your agent and `origin.via` to the integration.
  - `al-buddy-memory/ai-sdk` — `alBuddyMemoryTools` (remember, recall, invalidate, explain as AI SDK
    tools) and `alBuddyMemoryMiddleware`, which puts the pinned rules and the facts recalled for the
    turn in front of the model, fenced as data. Tested with `ai` 7.
  - `al-buddy-memory/langchain` — `AlBuddyMemoryStore`, a LangGraph `BaseStore` for
    `compile({ store })`: a second put to the same key retires the old value (kept in history), a
    delete invalidates rather than erases. Plus the four tools as LangChain tools. Tested with
    `@langchain/langgraph` 1.4 and `@langchain/core` 1.2.
  - `al-buddy-memory/mastra` — `alBuddyMemoryProcessor`, an input processor, and the four tools via
    `createTool`. Tested with `@mastra/core` 1.70 inside a real `Agent`.
  - `openAgentMemory(path)` in each: a governed SQLite store with the personal-default policies.
  - Guides: [docs/integrations](docs/integrations/).

### Behaviour change

- `consolidate()` no longer reads mental-model definitions as raw facts (a standing question is not
  something that happened).

## 0.6.0 — 2026-09-23

### Added

- **Conclusions go with their facts.** A fact that stops being true (`validTo` set) retracts every
  conclusion drawn from it, transitively — kept, with its text and history, and a `retraction`
  naming the source — so as-of reads still show what was believed and when it stopped. A fact that
  is erased takes every conclusion built from it with it, transitively, histories included, in the
  same transaction, so what was erased cannot be read back in a conclusion's words or rebuilt by
  the next pass. SPEC §8a has the two paths side by side; `src/derived-conformance.spec.ts` holds
  every store to them.
- **Governed: one decision for the whole closure.** Erasing asks the erase policies about the fact
  and every conclusion built on it; if any may not go (`memoryLock()`, a protecting policy) nothing
  changes and the refusal names the conclusion. Invalidating asks the update policies about each
  retraction. Audit events list every id. Recently deleted bins, restores and purges a fact and its
  conclusions together (`DeletedFact.with`); a conclusion cannot be restored on its own while its
  fact waits.

- **Evidence on every conclusion, checked.** `consolidate()` stores, for each derived fact, the
  exact passage(s) of each source it rests on (`contextualMetadata.evidence: [{ nodeId, quote }]`),
  and refuses one whose quotes are not in its sources ("unsupported: quote not found in source
  <id>", "unsupported: no quote from source <id>"). `verifyDerived(store)` re-checks every live
  conclusion's quotes any time — after an import, say — and retracts (never deletes) any whose
  evidence no longer holds; conclusions written before 0.6.0 carry no evidence and are named as
  unverifiable, not retracted. Evidence travels in the portable export unchanged (it is
  contextual metadata; the format version does not move).

- **`explainFact(store, id)` and the MCP `explain` tool.** Why a fact is believed, in one call: the
  fact and who asserted it (provenance, origin), when it was true and what ended or replaced it,
  how a conclusion was withdrawn, a conclusion's evidence with each quote checked against its
  source now, and a summary of its history. Through a governed handle the fact is explained only
  to a reader who may read it, and a source the reader may not read is named as withheld, its
  quote not shown.

### Behaviour change

- `deleteNode` erases more than the node named: every fact whose `derivedFrom` reaches it goes too,
  including one that also rests on a fact that survives. A host that deleted a source and expected
  its conclusions to stay will find them gone.
- `updateNode` that sets `validTo` on a fact with none retracts the live conclusions drawn from it,
  with a version recorded for each. Clearing `validTo` afterwards does not bring them back.
  `restoreNode` (import) never cascades.
- On a governed handle, an erase or an invalidation can now be refused because of a conclusion,
  not only because of the fact named.
- **`propose()` must return evidence.** A `DerivedFact` without `evidence` quoting every source it
  cites is refused. A host's consolidation prompt needs to ask its model for the quotes — see
  docs/STARTER.md.

## 0.5.1 — 2026-09-22

Fixes from a post-release review of 0.5.0. Every fix started as a test that failed on
0.5.0; the write-ups are in [docs/RESILIENCE-LEDGER.md](docs/RESILIENCE-LEDGER.md). No
schema change.

### Fixed

- **A fact derived by consolidation was always written Private**, whatever its sources
  were, so a restatement of a Sensitive fact reached assistants on recall. A derived fact
  is now Sensitive if any source is, and Sealed facts are never shown to the model.
- **The `enterpriseAudit` sample let a non-reviewer export the facts every read hid from
  them**, with their history. On export a policy's `beforeExport` replaces its own
  `beforeRead` (as designed); the sample now repeats its hiding rule there, and
  `policy.ts` and docs/GOVERNANCE.md say plainly that authors must.
- **`restoreDeleted` could answer with metadata the caller's read policy redacts**, when
  the restored fact landed in a tier hidden from them. It now returns only what the
  caller could already see, at the restored tier.
- **Page 2 was page 1 on SQLite.** `searchNodes({ after })` filtered for facts newer than
  the cursor while returning newest first. Paging now continues the list on both stores.
- **"What did we believe then" could be wrong and still say exact**, for a read inside
  the window before a refresh import. That window is now `exact: false`, as SPEC §8
  always said ("the join is marked").
- **An import could stop part-way** when two projects in one artifact were bound for the
  same store and disagreed about a fact or link. They are now checked against each other
  before anything is written. The same check stops refusing a valid artifact whose second
  project links to a node the first one brings.
- **A clock that stepped back made the store's own export unimportable.** A change is
  never stamped before its fact's latest recorded moment, and `exportedAt` is never
  earlier than anything in the export.
- **Consolidation erased an invalidation that landed while the model was thinking**: it
  marked each raw fact from metadata read before the model ran. It re-reads the fact
  first now.
- **Consolidation compared `since` as text**, so an offset such as `+10:00` skipped facts.
  It is compared as an instant.
- **The memory block cut to its limit before dropping unconfirmed facts**, so thirty
  unconfirmed facts left a block saying the project was empty.
- **The embedding backfill skipped Archived and PendingDeletion facts**, so a recall that
  names those tiers had nothing to find. What a recall may see is still decided when it
  reads.
- **MCP `remember` never embedded the new fact** when an embedder was wired.
- **The MCP handshake reported version "0.4.1"** from 0.4.2 on. It reads package.json now.

### Behaviour change

- `consolidate` no longer shows Sensitive facts to the model unless you pass
  `includeSensitive: true`, which follows the vocabulary's own rule that Sensitive is
  "excluded from summarization unless the user explicitly opts in". It throws when
  `since` is not a valid instant.
- MCP `pin` refuses text that reads like a secret, with a message saying why. Such a pin
  used to be stored Sensitive, hidden from the assistant that pinned it, reported as
  pinned, and duplicated on every retry. `PinnedBlocks.pin` throws when a policy hides a
  pin it just wrote.
- MCP `invalidate` refuses a `replacedBy` that names no fact the caller can see, or the
  fact itself.
- New MCP limits: `invalidate.reason` 500 characters, ids 128, `recall.query` 1,000. A 2 MB
  reason used to be stored and copied into every later history version.
- `searchNodes({ after })` with a cursor not in the list returns `[]` on every store (the
  in-memory store used to start again from the top). A non-finite `limit` means no limit,
  a negative one means 0, on every store.

## 0.5.0 — 2026-09-22

The store can now say what it believed at a past moment, not only what was true then. And
erasure got two safeguards: a lock, and a waiting period you can take back.

### Added

- **Transaction time.** Every `updateNode` records a version: the full before and after
  image of the fact's mutable fields, written in the same transaction as the change. The
  optional `HistoryCapable` capability, on both shipped stores, reads it: `history(id)`,
  `getNodeAsOf(id, asOf)` (returns `{ node, exact }`), `snapshotAsOf(asOf, { validAt })`,
  `historySnapshot()` and `restoreVersion(version)`. "What did we believe at X about what
  was true at Y" is one call. A read the recorded history cannot vouch for is marked, never
  guessed: changes made before 0.5.0 or by an older library, a fact a write policy reshaped
  on import, two stores' histories joined by an import. Schema v8 adds `node_versions`. The
  contract is docs/SPEC.md §8.
- **Portable format 1.1.0** carries versions, and 1.0.0 still imports. An imported version
  must sit on its fact's anchor trail: same instant and event, never before the fact was
  learned. One that does not is refused before anything is written, and so is a version id
  the destination already holds as a different change.
- **Governed history.** Access is decided on the fact as it is now, on the same read that is
  served. A fact the policies hide or redact today has its history withheld, because a rule
  written for the present cannot redact the past. `restoreVersion` is judged by the update
  policies, on the change it records. The MCP server gains a `history` tool.
- **`memoryLock()`**, a sample policy: while it is installed, nothing is erased on a governed
  handle, the owner included. Unlock it by removing it, or with a switch that reads exactly
  `false`. A switch that is missing or throws counts as locked.
- **Recently deleted**, opt-in: `govern(inner, { recentlyDeleted: { days: 14 } })`. An
  allowed `deleteNode` moves the fact out of recall for that many days instead of destroying
  it. `listDeleted`, `restoreDeleted` and `purgeDeleted` manage it. Purging asks the erase
  policies again, so a lock put on in the meantime keeps the fact. Nothing runs on a timer,
  and until purged the fact is still in exports and backups. Off by default.

### Behaviour change

- **An edit no longer removes the old value.** The earlier value stays in the fact's
  history, readable by anyone who may read the fact today. Erasing the fact is the only way
  to remove it. (Content was always immutable; now every earlier state is too.)
- Every `updateNode` writes one version row, reinforcements included. On the benchmark
  machine that is about 738 bytes each, so 100,000 updates add about 70 MB.
- `restoreNode` over an existing fact with different values records a `restored` version.
  An identical restore records nothing.
- Erasing a fact erases its history, in the same transaction.
- On every governed handle, a write that moves an EXISTING fact into or out of PendingDeletion,
  or changes its `deletionRequested` record, is also judged by the erase policies. Before, an
  update right was enough.
- An import whose `exportedAt` is in the future is refused before anything is written.

## 0.4.3 — 2026-09-21

Documentation only. No code, schema or behaviour changes from 0.4.2; this
release exists so the package page on npm matches the repository.

- The README opens with "A memory that's yours." again.
- The comparison in the README now also covers the local, keyless projects a
  reader is most likely to ask about, each cell sourced and dated.

## 0.4.2 — 2026-09-19

Alongside it, six fixes to the **MCP surface** — the only surface most people
will ever touch — which carry no schema change of their own. Full write-ups of
everything here, with the measurements, are in
[docs/RESILIENCE-LEDGER.md](docs/RESILIENCE-LEDGER.md).

### Added

- **The audit trail can live inside the database it describes.** `storeAudit(store)`
  writes hash-chained governance events into an `audit_events` table (schema v7),
  appended **inside the mutation's own transaction**. The fact and the event land
  together or neither does, so no commit can outlive its event — the window
  `docs/policies/ENFORCEMENT.md` has documented since 0.4.0, and the only way to
  close it was always to write both at once. It also means one chain rather than
  one file per process: the tail is read and extended under SQLite's write lock,
  so two assistants share a chain instead of forking it, and there is no
  directory of logs whose completeness nothing attests to. Two real processes
  prove it in `src/governance/audit-cross-process.test.ts`.

  This is an **optional store capability** (`AuditCapable`), in the same pattern
  as `SnapshotCapable`: `MemoryStore` is unchanged, a third-party store stays
  implementable, and `ChainedAudit`/`JsonlAudit` are untouched and still the
  answer for a store that cannot do this.

  What it does **not** change: the chain is tamper-*evident*, not tamper-proof.
  Whoever holds the key can still rewrite it, and a restored backup still carries
  a self-consistent chain of its own — anchor `head()` somewhere you do not
  control, exactly as
  before. And it is not a cross-process authorisation guarantee: the policy
  decision still happens before the transaction opens.
- **A cut tail is now caught in the table, where it used to verify clean.** A hash
  chain cannot prove its own tail — delete the newest records and what remains
  still verifies — which is why an anchored head hash is, and remains, the only
  answer to a deliberate edit. But a table knows something a log file does not:
  `AUTOINCREMENT` leaves a high-water mark that `DELETE` does not roll back. So
  `verify-audit` now names records removed from the end, a trail that was
  emptied, and a trail emptied and then kept in use — and a store whose trail
  was deleted **refuses to extend it** rather than beginning a second chain that
  claims to be the first. This is a defence against accident and careless
  deletion, not tamper-proofing: whoever can delete the records can reset the
  counter too. Measured: the mark survives `DELETE`, `VACUUM`, `VACUUM INTO` and
  `.backup()` (including one taken mid-write), and verification takes a single
  read snapshot so a second assistant writing at the same moment does not trip
  it. Pruning the trail is a deletion and trips it deliberately; the refusal
  message names the way out.
- **`al-buddy-memory verify-audit` takes a database.** Point it at `brain.db` and
  it checks the `audit_events` chain, plus any per-process JSONL logs still at
  `brain.db.audit/`, and says which is which. Files and directories of files work
  exactly as before.
- `SqliteMemoryStore` gained an `auditKey` option (HMAC for the table's chain)
  and exports `SCHEMA_VERSION`.
- `PINNED_HEADER`, `knownOrigin` and `readOrigin` are exported from the package root.

### Behaviour change

- **The MCP server writes its audit trail into the database by default.** It used
  to write `<db>.audit/<start>-<pid>.jsonl`. Existing logs are left exactly where
  they are — not adopted, not extended, and still checked by `verify-audit <db>`.
  Set `AL_BUDDY_MEMORY_AUDIT` to a path to keep writing a JSONL file instead (one
  server process per file).
- **On the `audit_events` path a failed audit append no longer latches the store.**
  It does not need to: the append is in the fact's transaction, so a failure rolls
  the fact back and nothing is left unrecorded. Latching would brick a store that
  lost nothing. The latch is unchanged for every sink that writes beside the
  database, which is where the failure it bounds can still happen.
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

- **A `sqlite3 .dump` backup could not be restored.** `.dump` does not carry
  `user_version`, so a restored file is a current schema labelled v0 and the whole
  migration chain replays over it. Everything tolerated that except `ADD COLUMN`,
  which threw on a column the dump had already created — so the restored database
  could not be opened at all (`duplicate column name: valid_from`). A column that
  already exists is now treated as that step being done; nothing else is swallowed.
  `.backup` and `VACUUM INTO` were, and remain, the recommended forms.

- Every mutating method of `SqliteMemoryStore` now runs in one `BEGIN IMMEDIATE`
  transaction (`mutation()`). `addEdge`, `deleteEdge`, `setEmbedding` and
  `deleteEmbeddings` were bare statements before; all four are now atomic and take
  the write lock up front, like the rest. Atomic *with the audit event* applies to
  the first two only — the embedding cache is not audited on any path, so for
  `setEmbedding` and `deleteEmbeddings` there is no event to be atomic with.
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
