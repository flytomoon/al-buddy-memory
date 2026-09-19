# al-buddy-memory 0.4.1 release review

**Verdict: no, I would not promote 0.4.1 unchanged on Tuesday, September 22.** The release gates are project-name collisions that merge separate memories, authorization races in the governed handle, continued unaudited writes after audit failure, and a broken fresh-user MCP installation example. These are reproducible defects, not objections to using SQLite. Most remaining findings are should-fix items or disclosed limitations.

Reviewed the checkout at `abac256`. The rebuilt `dist` and `package.json` match the downloaded npm 0.4.1 artifact. No implementation fixes were made. Review date: September 18, 2026, Pacific time.

## Evidence and limits

- `npm run check`: **243/243 tests passed**, typecheck and build passed, using Node 24.19.0. The original shell selected Node 20 against a Node-24 native addon. That local setup problem was resolved; it is not a product finding.
- Executed both CLI scoring examples and `verify-audit`. Exercised MCP initialization and all tool paths needed for remember/recall/invalidate/pin/pinned over real stdio. The handshake carries instructions and origin stamping works. A recognized password is absent from subsequent recall.
- Executed the real `LocalEmbedder`: two finite 384-dimensional vectors, about 895 ms using an already cached model. This is a runtime smoke test, not a quality evaluation or a fresh-download measurement.
- Executed `bench/bench.mjs` with 100,000 facts: 4,808 inserts/s, keyword median 40.8 ms / worst 154.4 ms, filters-only 0.6 ms, get 0.11 ms, invalidate 0.45 ms, DB 69.5 MiB. Raw-store figures broadly support the README. Governed reads varied substantially: approximately 490 ms, 180 ms, and 1,987 ms for `azores`, `kubernetes espresso`, and `day`; do not generalize one machine/run to universal latency.
- Created a database with the actual published 0.3.3 library, including an invalidated node and an edge. Opening in 0.4.1 and exporting/importing preserved the facts, validity instants, and edge.
- SIGKILL smoke test: ten acknowledged writes survived, SQLite integrity check returned `ok`, and FTS also contained ten rows. This does not prove power-loss durability; `synchronous=NORMAL` deliberately allows loss of recent transactions on power failure (`src/sqlite-memory-store.ts:323`).
- Four simultaneous first opens produced `SQLITE_BUSY` failures at WAL setup in some processes; the surviving store remained intact. This is outside the advertised one-process/one-writer envelope. Two independent audit writers also fork a chain, as the docs explicitly warn.
- `npm audit --omit=dev` reported zero advisories for the installed dependency tree at review time.
- Reproduction scripts and logs are in `/tmp/al-buddy-review/`: `probes.mjs`, `extended-probes.mjs`, `mcp-stdio.mjs`, `stress.mjs`, and corresponding logs. Run scripts with `/Users/chriscanfield/.nvm/versions/node/v24.19.0/bin/node` in this environment. They use disposable databases and synthetic facts.

## Release-blocking

### R1. Distinct project names silently share the same database

**Impact:** a person/project can recall another scope's private facts.

`projectDbPath` replaces every character outside `[a-zA-Z0-9_-]` with `-` (`src/project-memory.ts:43-48`), so `org/repo` and `org-repo` map to the same file. Many Unicode names also collide. This contradicts the separate-brain claim in `README.md:39` and the explicit isolation comment at `src/project-memory.ts:12-17`.

**Reproduced:** create `ProjectMemory('org/repo', {baseDir})` and `ProjectMemory('org-repo', {baseDir})`; capture a fact in the first; recall it from the second. The second returns the private fact.

**Fix:** use an injective encoding or a stable digest of the full scope identifier, retain the original scope in the database, and reject mismatches. Plan existing-filename migration; simply changing the filename algorithm can strand existing users' stores.

### R2. Concurrent governed operations can undo a privacy restriction

**Impact:** a model-facing handle can demote a fact after the owner has made it Sensitive.

`updateNode` checks a snapshot with `visibleOrNotFound`, awaits asynchronous policies, and commits against the current row without a revision check (`src/governance/governed-store.ts:154-168`). Async hooks are expressly supported (`src/governance/policy.ts:28-32`). The raw SQLite transaction protects the eventual write, not the earlier authorization decision.

**Reproduced:** an agent begins an allowed `{privacyClassification:'Private'}` update on a Private fact; a Promise-returning policy pauses it; the owner changes the fact to Sensitive through another governed handle; the agent resumes. Final classification is Private and the agent can read it. A variant updating only confidence returns stale `seen` data even when the final `beforeRead` hides the row. No raw-store mutation is needed during the race.

**Fix:** serialize authorization-plus-mutation across handles or use revisions/compare-and-swap with policy revalidation on conflict. Review erasure/import/link operations for the same separation between check and use. Removing the stale-return fallback alone does not prevent the unauthorized demotion.

### R3. A poisoned audit sink does not stop governed writes

**Impact:** rejected operations continue changing the database with no possible audit event, and client retries can compound the changes.

Every mutator writes to the inner store before recording (`src/governance/governed-store.ts:145-151`, `:165-166`, `:202-203`). `ChainedAudit` correctly stops further log appends after a torn append (`src/governance/audit.ts:137-161`), but the governed store never stops mutations.

**Reproduced:** first add succeeds; second append writes twenty bytes then throws simulated ENOSPC; third add rejects on the poisoned audit promise. All **three** nodes persist, with only one complete audit event and a fragment. The third write happens after the audit is already known to be unusable.

`docs/policies/ENFORCEMENT.md:22` already acknowledges the first commit-before-audit failure; that deliberate limitation is not the new finding. Continuing all subsequent writes is the additional defect. The “fails closed” language in `docs/GOVERNANCE.md:45-50` must not imply that governed state stops changing.

**Fix:** latch a failed state before any subsequent mutation; the MCP process should stop serving mutations after a sink failure. For an actual every-commit-is-audited guarantee, use a transactional outbox or database-backed audit event committed with the mutation. Preserve the documented initial failure window until that is implemented.

### R4. The published MCP quickstart fails on a fresh installation

`README.md:191-192` invokes `npx al-buddy-memory-mcp`, but the npm package is `al-buddy-memory`; that is only one of its executable names (`package.json:77`). In a clean temporary directory, `npx --yes al-buddy-memory-mcp` returns npm **E404**.

The example also passes `~/.al-buddy-memory/brain.db` as an environment value. Neither the launcher (`bin/al-buddy-memory-mcp.js:12`) nor the SQLite constructor expands `~`. The stdio test created a literal `cwd/~/.al-buddy-memory/brain.db`. On some clients this instead fails because their working directory is not writable.

**Fix:** use `npx -y --package=al-buddy-memory@0.4.1 al-buddy-memory-mcp`, and omit the DB environment setting to use the correctly resolved home-directory default, or support tilde expansion/use an absolute path. Smoke-test the exact published configuration outside the repository.

## Should fix before Tuesday

### R5. Portable import preflight does not prevent partial imports

The promise to validate the whole artifact before touching stores is explicit at `src/memory-portability.ts:112-115`, but the validator checks only a subset of field shapes (`:117-148`). It does not fully validate dates, weights, enums, anchors, unique IDs, or graph references. Actual restoration runs sequentially without rollback (`:159-167`).

**Reproduced in both stores:** export two valid nodes, set the second node's confidence to `2`, and import into an empty store. Import throws but the first node remains committed. A valid artifact can likewise fail halfway on a destination conflict, policy refusal, or missing edge endpoint.

**Fix:** complete structural/semantic preflight, then provide an atomic per-project import or staging-and-swap. Preflight alone cannot make destination conflicts or disk errors atomic. If cross-project atomicity is out of scope, document it and return a recoverable import status.

### R6. Export is not a consistent snapshot under concurrent writes

`exportPortable` awaits node enumeration, then fetches edges one node at a time (`src/memory-portability.ts:59-69`). There is no snapshot/transaction contract.

**Reproduced in both stores:** start with two connected nodes, start export, delete one node immediately after the export call, and await export. The artifact contains **two nodes and zero edges**. The store was first two nodes plus one edge, then one node and no edges; the exported graph never existed as a state of the store.

**Fix:** snapshot node and edge enumeration together. Until supported, explicitly require writes to be quiesced while exporting; “lossless backup” should not imply live snapshot safety. In a quiescent, valid store, the all-tier/all-classification node-and-edge round trip passed.

### R7. MCP recall can return no current facts even when they exist

`recall` takes `limit * 2` candidates before removing superseded facts (`src/mcp/governance-server.ts:123-129`). Oversampling does not ensure a full current page.

**Reproduced in both stores:** sixteen high-ranking retired `quokka` facts and one lower-ranking current fact; default MCP recall returns `[]`, while a store search with `validAt: now` returns the current fact.

Also, `toGovernedFact` defines `current` solely as `validTo === null` (`:52`). A fact beginning in 2099 is reported current today; a fact valid from 2020 until 2099 is filtered out today. Both cases reproduced.

**Fix:** apply the valid-time predicate before candidate limiting when history is not requested, and compute `current` from `[validFrom, validTo)` at the query instant. Preserve an explicit all-history path.

### R8. JavaScript/import callers can violate the required schema vocabulary

The shared input functions enforce instants and numeric node weights, but not most of the public schema (`src/instant.ts:70-109`). Both stores accept arbitrary node provenance/type/privacy/retention strings; edges accept arbitrary type/provenance and out-of-range strength (`src/sqlite-memory-store.ts:814-840`). Anchor-event values are unchecked too.

**Reproduced:** SQLite stores a node with `provenance:'forged'`, `memoryType:'bogus'`, and invalid classifications; an edge with strength `9` also stores. Changing a raw-store classification from `Sealed` to the invalid spelling `Sealed ` makes the fact searchable. This is a validation/fail-open issue, not a bypass by a client denied all classification changes. In-memory creation also lacks the SQL NOT NULL backstop.

**Fix:** runtime validation shared by add/update/restore/import, including required fields and enums, anchor events, edge bounds, and JSON-compatible payloads. Valid-time interval ordering should also be defined. TypeScript types do not satisfy the requested JavaScript contract.

### R9. Same-name embedding-model upgrades silently use stale vector spaces

`modelVersion` is stored but never used to select candidates. `vectorCandidates` only checks vector length (`src/hybrid-retriever.ts:144-153`); `indexMissingEmbeddings` treats any row for the model name as current (`:195-200`).

**Reproduced:** index with model `m`, version 1; switch to version 2 with the same dimensions and a different vector space. Backfill reports **0** rows indexed and recall returns the version-1 answer. Changing dimensions avoids comparing the old vectors, but backfill still does not replace those existing rows.

**Fix:** filter by version/configuration identity and reindex mismatches. Pin the actual model revision/configuration, rather than a manually fixed `modelVersion='1'` (`src/embedder.ts:54-55`). Raw text survives, as promised; retrieval correctness during the upgrade does not.

### R10. Built-in derivation can weaken privacy, and secret scanning misses provenance payloads

`consolidate` always creates a Private derived node (`src/consolidation.ts:115-125`), regardless of source classification. With an owner-context governed handle, Sensitive sources are readable and eligible for consolidation.

**Reproduced:** a Sensitive support-group fact was not readable by the agent. Consolidation copied its text into a Private derived fact; the agent could read the derived fact. This is a dangerous default declassification during the supplied workflow, not an assertion that an owner may never deliberately declassify a fact.

Separately, `personalDefaults.beforeWrite` only scans `content.text` (`src/governance/samples.ts:38`). A harmless summary plus `buildSourceProvenance({user:'password: review-placeholder', ...})` remains Private and exposes the password in `contextualMetadata.sourceExchange` through governed `getNode` (`src/provenance.ts:32-42`). The shipped MCP does not accept arbitrary metadata, so this second path concerns library users.

**Fix:** inherit the strongest source classification unless declassification is explicit; protect raw source exchanges/structured content as well as summary text. Describe the regex scanner as a limited detector, not comprehensive secret detection.

### R11. Consolidation can commit incomplete evidence and undo only part of a pass

Nodes, evidence edges, and source markers are separate writes (`src/consolidation.ts:126-135`). Two overlapping passes can read the same unmarked raws and create duplicate conclusions. Deleting a source while `propose` is pending makes the later edge fail **after the derived node has committed**; reproduced in both stores with a surviving derived node and no evidence edge.

`undoConsolidation` and `listConsolidations` enumerate default searches (`:184`, `:226`), which omit Archived/PendingDeletion/Sealed facts. Archive a derived fact, then undo its pass: undo reports no retraction and leaves `validTo:null`. Restoring its retention tier can reactivate the conclusion supposedly undone. This contradicts the whole-pass claim at `README.md:44`.

**Fix:** atomic derived-node/evidence/marker commits, unique run identity and overlapping-run coordination; enumerate all authorized tiers for review/undo, not active-search defaults. A timestamp alone as run identity also merges passes started at the same millisecond (`:185-199`).

### R12. Pinned rules silently disappear after enough ordinary Lessons

`PinnedBlocks.list()` limits to 500 Lessons **before** filtering to pins (`src/pinned.ts:87-101`).

**Reproduced:** pin one rule, then add 500 newer ordinary Lessons. `list()` returns `[]` and `render()` returns an empty string, despite the pin still being valid. The budget overflow notice is never reached. This is separate from the deliberate rendering budget.

**Fix:** filter to pinned facts before paging, or enumerate all eligible pins. Concurrent same-text calls also duplicate pins because list-and-add is not atomic (`:47-71`); address uniqueness when adding the proper query path.

### R13. The conformance scorer can give malformed input an A and ignores recorded provenance in another shape

The portable adapter hardcodes invalidation, schema-publication, and itemisation traits (`src/conformance/adapters.ts:50-57`). The scorer accepts any nonempty provenance label and any non-null `validFrom` (`src/conformance/score.ts:57-70`). Even a failed round trip receives 10 percentage points toward portability (`:114`).

**Reproduced:** a two-fact artifact with `validFrom:'not-a-time'`, invented provenance, and an edge fails import but scores **A, 96.2%**. The failure is visible in its portability explanation; the headline grade still rewards it.

The flat-record adapter always sets provenance to null (`src/conformance/adapters.ts:116-125`). Adding `metadata.provenance:'UserInput'` does not improve its score. Thus `docs/SCORING.md:36-38` (“record who asserted ... 100% for any system”) is false for a shipped adapter.

**Fix:** reject malformed portable artifacts, validate time/reference fields, make adapter limitations explicit, and withdraw “cannot be gamed” (`docs/SCORING.md:1`, `:28`). Keep this useful export-metadata checklist separate from behavioural backend conformance and independent system comparisons.

### R14. Public claims are still inconsistent or unsupported

- `docs/SPEC.md:66-77` and `:98` still claim bi-temporal memory; `README.md:20` correctly says historical belief state cannot be reconstructed. Mutable validity/confidence/tier values have no version history. Make the spec agree with the README.
- The competitor table at `README.md:17-24` has no source links and compresses Mem0 into “Cloud is the product.” Its official docs explicitly offer a local library/self-hosted engine, with local LLM and embedding providers. Distinguish Mem0 OSS from its hosted product. Zep cloud and open-source Graphiti also need to be distinguished; do not imply Graphiti has no source provenance or temporal retrieval.
- The Letta `.af` archival-memory caveat is currently supported by its docs; I am not flagging that cell as false.
- `docs/RESILIENCE-LEDGER.md:132-136` says no open cases, while `CHANGELOG.md:231-250` lists known issues. Its “client never calls memory: fixed” entry (`:116-125`) demonstrates instruction delivery, not successful invocation by real clients. Label that mitigation honestly until there is a host-level evaluation.
- The public demo still says “Never deleted” (`docs/demo/index.html:85`, also meta description at `:9`) after the release explicitly withdrew that guarantee.
- The model-size claim is wrong for the selected configuration: `src/embedder.ts:70-72` requests `fp32`; the actual cached ONNX model is **90,387,606 bytes**, not approximately 25 MB (`README.md:148`, `src/embedder.ts:50`).
- The starter constructs a governed handle but continues using the raw `store` for consolidation and the previously constructed pins (`docs/STARTER.md:15-16`, `:33`, `:52`). Correct the tutorial to actually pass the governed capability.

Primary sources checked: [Mem0 OSS](https://docs.mem0.ai/open-source/overview), [local LLM](https://docs.mem0.ai/components/llms/models/ollama), [local embeddings](https://docs.mem0.ai/components/embedders/models/ollama), [Graphiti](https://github.com/getzep/graphiti), [Letta AgentFile contents](https://docs.letta.com/v1-sdk/concepts/agent-file).

### R15. The MCP trust model needs an explicit memory-poisoning boundary

This is **deliberate, documented authority**, not a newly discovered provenance-authentication bypass. The server acts as owner with an AI audience (`src/mcp/governance-server.ts:67-73`), accepts caller-chosen provenance/defaults to UserInput (`:106-120`, `:173-175`), and lets the model pin/unpin/invalidate. Pins default to UserInput and render under “always true” (`src/pinned.ts:58`, `:124`). Provenance is explicitly writer-asserted in `README.md:105`.

A prompt-injected assistant can persist invented UserInput facts and instructions, pin them for future sessions, and retire legitimate facts. The server itself does not execute those instructions or exfiltrate credentials; downstream tools and the host's authority determine that impact. Governance restricts classified reads, not the truth or safety of an allowed write.

**Before launch:** state this boundary adjacent to the MCP setup, use AIInferred for model-authored facts unless the host can establish user authorship, and offer host-controlled approval/authority for durable rules. A textual “untrusted data” envelope helps framing but is not a security boundary. The ordinary renderer already has one (`src/memory-block.ts:43-50`); the pinned renderer asserts the opposite. Do not claim automatic prompt injection of pins: the host must call `pinned`/render and place the result, and server instructions currently do not request that call.

## After Tuesday / explicitly limited

### R16. Smaller contract and operations issues

- **Known cursor inconsistency:** `src/sqlite-memory-store.ts:626` selects creation times greater than the cursor despite descending order; in-memory uses the rest of the ranked list (`src/in-memory-store.ts:131`). Reproduced first-page cursor returning no next page. Already disclosed at `CHANGELOG.md:233`; define/remove before 1.0.
- **Known retriever restrictions:** per-model vector caching is not per-actor (`src/hybrid-retriever.ts:40-55`); use a retriever per actor. Current candidate fetching still rechecks node visibility (`:166-170`), so I did not confirm cross-actor fact-text disclosure. Optional embedded MCP history recall omits superseded facts; already disclosed in `CHANGELOG.md:246-250`.
- **Legacy timestamp normalization:** migration preserves anchor spellings (`src/sqlite-memory-store.ts:243-275`), but import normalizes them (`src/instant.ts:98-105`). Valid instants survive; byte-for-byte identity does not. Define losslessness semantically and make the scorer compare timestamps accordingly. Legacy unparseable bounds deliberately remain; document a repair/quarantine path rather than saying every historical instant is canonical.
- **Consolidation selection:** `since` is compared as caller text without canonicalization (`src/consolidation.ts:83`); an equivalent offset instant can exclude a boundary fact. The 5,000-row candidate cap precedes chronology/unconsolidated filtering (`:80-86`), so this is not a full backlog drain.
- **Audit detail is sampled:** a read of 25 nodes records only 20 IDs and count 25 (`src/governance/audit.ts:15-26`, `src/governance/governed-store.ts:38`). Deliberate in code, insufficiently clear beside “who read what.” This log is not a complete access inventory or a cryptographic commitment to database contents.
- **Existing audit-file permissions:** both appenders request mode 0600 only on creation (`src/governance/audit.ts:39-41`, `:93-94`). A pre-created 0644 file remains 0644. Repair or reject permissive existing audit files; the default protected directory reduces this exposure.
- **One audit writer really means one:** two MCP clients independently launching the stdio executable against one DB also share one audit path. Document that topology prominently or enforce singleton ownership. The documented one-writer limitation itself is not a hidden defect.

## What holds up

Runtime immutability of supported raw content/provenance/identity/key fields and existing anchor history is implemented in both stores (`src/immutable.ts:11-59`). Read results are copied. SQLite node/FTS operations and migration version changes are transactional; update locks before reading. The governed handle does not expose the raw database/maps. Erasure is denied without policy permission. Normal node/edge/embedding visibility checks and visible-only keyword ranking are substantive protections. The browser scorer escapes interpolated input and does not send pasted exports to a service (`docs/demo/index.html:153-181`).

The documented limits around unauthenticated provenance, raw-store capability ownership, no encryption at rest, exportView, missing beforeLink, redaction-search leakage, HMAC key ownership, anchored heads, and timing hints should be retained. A valid HMAC chain proves integrity of those recorded audit events, not authenticity of facts or integrity/completeness of SQLite contents. There is no basis for claiming this library prevents every prompt injection or verifies whether a cited source entails a conclusion.

## Hostile HN objections

| Objection | Does it land? | Honest answer |
|---|---|---|
| “SQLite with one writer is not a memory system.” | No, as a categorical objection. | A personal memory library can reasonably use SQLite. It supplies validity, evidence links, governed access, interchange, and lifecycle helpers. It is not a shared multi-tenant service; no rushed Postgres rewrite is needed for this launch. |
| “This is a wrapper around FTS5.” | Partly, on retrieval. | The shipped MCP is keyword-only. The optional hybrid path adds a full vector scan and rank fusion, not graph traversal or sophisticated memory reasoning. The defensible value is the data/access contract, subject to the fixes above. |
| “On-device embeddings are too weak to matter.” | Not established; the counterclaim of strong recall is also unproven. | MiniLM works locally. Twelve keyword fixtures and a synthetic throughput benchmark do not establish semantic or end-to-end agent quality. Publish a modest paraphrase/temporal/correction test and compare lexical versus hybrid recall. |
| “The scorer grades its own homework.” | Yes. | It is an author-defined metadata score with adapter priors, plus an actual artifact round-trip check. It is not an independent superiority benchmark. R13 gives concrete evidence, not just a rhetorical criticism. |
| “Invalidate-never-delete means unbounded growth.” | Yes, deliberately. | Raw retention buys recoverability. Decay changes rank, not disk usage. Erasure exists; automated archival/compaction/deletion does not. The measured 69.5 MiB excludes vector and audit growth: 100k × 384 float32 values alone is 153.6 MB before JSON/index/row overhead. Say what is retained and measure the configured system. |
| “Provenance means an AI selected a label.” | Yes for the provenance enum. | It is an immutable assertion category, not verified authorship. MCP origin adds client-reported app identity, but remains mutable metadata in 0.4.x. Structural source links support review; they do not prove truth. |

## State-of-the-art gap analysis, as of September 2026

The useful next work is stronger guarantees and evaluations, not a last-minute list of fashionable memory features.

| Area | What is genuinely missing | Priority / scope judgment |
|---|---|---|
| Bi-temporal history | Versioned mutable state and record-time/as-of queries; anchors contain events, not prior values. | **After**, while correcting the spec before Tuesday. This is a real gap if historical belief reconstruction is a goal. Graphiti exposes separate valid/invalid and created/expired temporal filters ([source](https://github.com/getzep/graphiti/blob/main/graphiti_core/search/search_filters.py)). |
| Graph versus vector recall | Entity resolution, graph-assisted/multi-hop retrieval, contradiction reconciliation, and an evaluation showing when they improve answers. Stored links are not used by hybrid retrieval (`src/hybrid-retriever.ts:68-84`). | **After**, driven by actual workloads. Graphiti already combines temporal graph, semantic, and lexical retrieval ([project](https://github.com/getzep/graphiti)). A graph database is not required merely to traverse links; the spec's Neptune/Neo4j requirement is unnecessary. |
| Consolidation and forgetting | Reliable run commits/recovery, privacy inheritance, complete undo, bounded active context, and a lifecycle for raw/vector/audit growth. Derived facts need review; source IDs alone do not validate an inference. | **Before Tuesday** for R10–R12; automation/compaction **after**. Retaining raw data is a deliberate defensible choice. Letta already offers editable/shared memory blocks ([docs](https://docs.letta.com/tutorials/attaching-detaching-blocks/)); do not present the basic pattern as novel. |
| Procedural memory | A Skill enum stores prose; there is no workflow/skill lifecycle with execution outcomes, versioning, verification, and success-conditioned reuse (`src/types/memory.ts:38`). | **After / mostly host responsibility.** Do not add executable procedures merely to claim procedural memory. A reliable agent can layer them on this storage contract. |
| Scoped/multi-agent recall | Mandatory actor/scope binding, authenticated authorship, safe shared cache identity, and supported multi-client writer coordination. Existing tags are useful filters, not tenant isolation. | **Before Tuesday** for isolation/authorization fixes; a multi-tenant platform is rightly out of scope. Separate files remain a valid personal-memory design once names cannot collide. |
| MCP | Valid-time/history/export/consolidation-review tools, optional embedder/index wiring, complete provenance/actual effective-confidence presentation, and host-level invocation/poisoning evaluation. The six-tool server is intentionally small (`src/mcp/governance-server.ts:173-184`). | Correct setup and recall **before Tuesday**; expand **after** based on user needs. Instructions being present does not prove clients use memory or place pins in every prompt. |
| Independent interoperability and evaluation | Another implementation importing the complete format, plus adversarial format tests and an end-to-end test of corrections, conflicting facts, poisoning and invocation. | **After**, with honest claims now. Importing into this library's own two backends is useful conformance evidence; it does not demonstrate adoption by another runtime. |

A native Python SDK, Postgres, production tenant management, encryption/key custody, and mature automated deletion workflows can reasonably remain out of this small local library's launch scope if the docs keep those boundaries explicit. JSON-LD/SHACL badges, a graph backend without useful retrieval, and more memory-type enums without tested behaviour would be theatre.
