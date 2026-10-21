# al-buddy-memory and akitaonrails/ai-memory, compared (2026-10)

[ai-memory](https://github.com/akitaonrails/ai-memory) is a comparison
point, not a dependency. Nothing from it is installed, vendored or imported here.

Read at commit [`ad26451`](https://github.com/akitaonrails/ai-memory/tree/ad264519488c06e4468f1ad9f805d5fed2f97855)
(2026-10-21, release 3.1.2), against al-buddy-memory 0.12.0 (`main` at
`400bc5c`). Every claim about ai-memory below cites a file at that commit.
Links that end in a path are relative to that tree.

**What could not be done.** ai-memory could not be run in the sandbox this was
written in. It is Rust (about 511,000 lines) and there is no Rust toolchain here.
Its prebuilt release binaries are served from `release-assets.githubusercontent.com`,
and that host is outside the network allowlist. So nothing below was run against
ai-memory: there is no measurement of its recall on our eval set and no latency of
our own. Section 3 compares published numbers, and says where they are not
like-for-like.

## At a glance

| | al-buddy-memory | ai-memory |
|---|---|---|
| What it is | A library with an MCP server and a Claude Code plugin. Memory of facts about a person and their work, with governance on every write and read | A server you run, with hooks and plugins for 20+ coding-agent harnesses. Memory of coding sessions, consolidated into wiki pages |
| Source of truth | The raw text of each fact in SQLite (or Postgres), immutable after write | Markdown pages in one git repo |
| Index | The same database: FTS5, plus float32 vectors keyed by `(nodeId, model)` | A derived SQLite index: FTS5, entities, links, and float32 vectors keyed by provider/model/dim |
| Time | Bi-temporal: valid time (`validFrom`/`validTo`) and transaction time (`snapshotAsOf`) | Ingestion time only |
| Delete | Invalidate, never overwrite. Erasure only through policy, audited, with a receipt | Supersede on write. Hard delete by tool, TTL, and a daily decay sweep. Git history never rewritten |
| Capture | Explicit: the agent calls `remember` | Automatic: lifecycle hooks capture prompts and tool calls |
| Recall | Keyword + vector, RRF (k=60), optional `expand` and cross-encoder | FTS + entity + vector + graph + observation streams, RRF (k=60), authority multiplier |
| LLM needed | No (on-device MiniLM) | No (on-device MiniLM). An LLM is optional for consolidation and rerank |
| Runtime | In-process, or `npx` stdio MCP; no daemon | A per-user service on `127.0.0.1:49374` |
| Licence | Apache-2.0 | MIT |

## 1. Data model

**ai-memory: markdown in git is the truth; SQLite is derived.**
- [`docs/design-decisions.md:42`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/design-decisions.md#L42):
  *"Markdown in a git repo is the source of truth, and SQLite is a derived index."*
- Layout: one repo for every project, at
  `<wiki_root>/<workspace_uuid>/<project_uuid>/{sessions,decisions,gotchas,concepts,_rules,…}/*.md`
  ([`docs/lifecycle-ops.md:227-261`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/lifecycle-ops.md#L227-L261)).
  Directory names are UUIDs, and human names live in `_meta.md`.
  Frontmatter carries a type, tier, entities, tags, `expires_at`, `pinned` and
  typed `relations` (a closed set: `causes`, `fixes`, `contradicts`).
- Commits are made in-process by libgit2 as `ai-memory <ai-memory@local>`. That is
  one commit per session end, per pre-compact checkpoint, per consolidation and per
  MCP page write
  ([`crates/ai-memory-wiki/src/git.rs:3-5,30-34`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-wiki/src/git.rs#L3-L34)).
  Individual hook observations are not committed: they go to a monthly ledger file
  and to SQLite.
- The index is **partly** rebuildable. `ai-memory reindex` rebuilds pages, links
  and FTS from the files. Sessions, observations, handoffs, decay counters and
  superseded versions live only in SQLite (and, for versions, in git history)
  ([`crates/ai-memory-wiki/src/wiki.rs:2377-2381`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-wiki/src/wiki.rs#L2377-L2381)).
- Vectors are a brute-force cosine scan over packed f32 blobs, the same choice we
  made. `sqlite-vec` is "deferred intentionally, not rejected"
  ([`docs/vector-backend-policy.md:3-5`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/vector-backend-policy.md#L3-L5)).

**Ours: the fact is the unit, and the raw text is the truth.** Each fact is a
node with provenance, valid time, confidence, privacy and retention tier. Its raw
text is immutable after write. Vectors are a disposable, model-tagged cache. The
interchange is a versioned JSON export with a published schema
([portable-format.schema.json](../portable-format.schema.json)), and
`export --format markdown` gives a readable mirror. See [SPEC.md](../SPEC.md).

**The difference that matters.** ai-memory's unit is a *page*, which is
rewritten as a session or consolidation proceeds. Its history lives in git and in
superseded rows. Ours is a *fact*, which is never rewritten. "Open it in
Obsidian, `grep` it, `rsync` it" is a real usability win for a coding-session
log, and it is the same win basic-memory offers. It is also why editing a file by
hand is a supported write path there and could never be one here, where the raw
is immutable and provenance is checked.

## 2. No-delete and invalidation

**ai-memory has no global no-delete rule.** What it has is narrower:
- **A concurrent write supersedes rather than destroys.**
  [`AGENTS.md:501-504`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/AGENTS.md#L501-L504):
  *"A divergent concurrent write supersedes, never destroys … the loser stays reachable."*
  A changed write closes the old row (`is_latest=0`, `valid_to=now`) and inserts a
  new one that points back with `supersedes`
  ([`crates/ai-memory-store/src/ops.rs:1862-1935`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-store/src/ops.rs#L1862-L1935)).
- **Time is ingestion time only.**
  [`docs/temporal.md:17-22`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/temporal.md#L17-L22):
  the columns *"record when ai-memory learned and replaced a fact, not when it was
  true in the world"*. A world-time split is *"deliberately out of scope"*,
  because dating facts would take an LLM. `as_of` covers the FTS and entity
  streams, not vectors or graph.
- **`contradicts` edges only feed lint.** They retire nothing
  ([`docs/typed-edges.md:53-58`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/typed-edges.md#L53-L58)).
- **Hard delete is real, and part of it is on by default.**
  - `memory_delete_page` removes the file and every version row
    ([`ops.rs:3969`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-store/src/ops.rs#L3969)).
  - A daily forget sweep runs by default. It hard-deletes pages past their
    `expires_at` TTL ("pin or not") and tombstones cold episodic pages. After 180
    days it purges those tombstones "with their full version ancestry"
    ([`docs/ARCHITECTURE.md:196-203`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/ARCHITECTURE.md#L196-L203);
    defaults in [`DATA_HANDLING.md:105-117`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/DATA_HANDLING.md#L105-L117)).
    Semantic, procedural and pinned pages are exempt from decay.
  - `purge-session`, `purge-project` and `delete-workspace` cascade.
- **Erasure is honest about git.**
  [`docs/lifecycle-ops.md:100-104`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/lifecycle-ops.md#L100-L104):
  *"`--compact` is not forensic erasure"*. Content stays in git objects and commit
  messages, and the server never rewrites that history. There is "no
  data-subject-request tooling"
  ([`DATA_HANDLING.md:77-79`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/DATA_HANDLING.md#L77-L79)).

**Ours.**
- `invalidate` closes valid time and keeps the record, with `retiredBy` and
  `supersededBy`. The MCP server has no erase tool.
- Erasure exists only on a governed handle. It goes through policy (`memoryLock()`
  refuses it for everyone), can be held in Recently deleted, removes the fact's
  history too, takes conclusions drawn from the fact with it, and returns a receipt
  chained into the audit trail ([ERASURE.md](../ERASURE.md)).
- Nothing expires on a timer.

**Reading it.** The two systems put the line in different places for good
reasons. A coding-session log wants old episodes to fade. A person's memory
wants nothing to vanish unless someone with standing asked. ai-memory's design
also means *"deleted"* and *"erased"* differ: content survives in git. That is
the right thing to say plainly, and they do. Our erasure removes history in the
store, and the receipt says that backups and exports made earlier are outside it.
Neither system's model fits the other's purpose. There is nothing to adopt in
either direction.

## 3. Recall quality

**ai-memory's pipeline.**
- Up to six ranked streams: FTS5 (bm25, stopwords dropped, OR-joined), entities,
  vectors, abstract vectors (off), one-hop graph expansion, and an "observation
  stream" in which each captured session votes once for its session page.
- Fused by RRF with k = 60
  ([`crates/ai-memory-store/src/reader.rs:6787-6788`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-store/src/reader.rs#L6787-L6788)),
  then scaled by an "authority" multiplier from page kind, tier, pin and tags
  (clamped to 0.55–1.50).
- Default top-k is 10. There is no LLM on the default path. An LLM reranker and
  answer synthesis are opt-in.

Our `HybridRetriever` also uses RRF with the same constant
(`RRF_K = 60`, [src/hybrid-retriever.ts](../../src/hybrid-retriever.ts)), over
keyword and vector lists, plus `freshness` and the `expand` cue lists.

**Their eval** is LongMemEval-S retrieval only. It replays each question's
sessions through the real hook capture path into a real `ai-memory serve`, then
queries through MCP. They publish no end-to-end QA number
([`docs/comparison.md:396`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/comparison.md#L396)).

**Our eval** is the same dataset, end to end: 500 questions, one memory per
message, a Claude reader, and re-graded by the official gpt-4o judge. Beside it
sits `recall-sweep.mjs`, retrieval only, over two 50-question sets: the "gain"
set (`--limit 50 --types multi-session,temporal-reasoning`) and the "break" set
(`--limit 50`).

Published numbers, side by side:

| | ai-memory 3.1.2, FTS only | ai-memory 3.1.2, local MiniLM | al-buddy-memory, hybrid MiniLM + `expand` |
|---|---|---|---|
| Questions scored | 470 (500 less 30 abstention) | 470 | 419 for retrieval (also skips 51 with no user-side evidence, as the official metric does); 500 for QA |
| Session hit@1 / recall_any@1 | 0.857 | 0.768 | 0.504 |
| Session hit@5 / recall_any@5 | **0.951** | **0.947** | **0.938** |
| Session hit@10 / recall_any@10 | 0.972 | 0.977 | 0.969 |
| End-to-end QA, official gpt-4o judge | not published | not published | **92.8%** (94.4% task-averaged) |
| Context the reader gets | top 5 hits, ~528 tokens | same | 20–40 rounds (mean 33); the whole reader prompt averages ~76,000 characters |
| Recall latency p50 / p95 | 12 / 103 ms | 98 / 225 ms | 11.7 / 33.5 ms |
| What the latency times | MCP round-trip to a local server, concurrency 6, Ryzen 9 7950X3D | same | the `recall` call in-process, one at a time, M1 Pro |

Sources:
- ai-memory:
  [`docs/benchmarks/longmemeval-s-3.1.2-release.md`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/benchmarks/longmemeval-s-3.1.2-release.md)
  and [`evals/README.md:283-313`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/evals/README.md#L283-L313).
- Ours: [bench/results/2026-09-30-lme-full-fast.json](../../bench/results/2026-09-30-lme-full-fast.json)
  (`summary.retrieval.session`, `summary.recall`), and the gpt-4o re-grade in
  [bench/results/README.md](../../bench/results/README.md).

**Why this table ranks nothing.**
- **The denominators differ.** They score 470 questions. The official metric we
  use scores 419: the 51 questions whose evidence is only in assistant turns are
  skipped. All 51 are single-session-assistant, a slice they score at 0.893
  (local) and 1.000 (FTS).
- **The documents differ.** Their hits are session pages, built by their capture
  pipeline plus a session-level vote. Our hits are single messages, ranked and
  then mapped to sessions by first appearance.
- **The operating point differs.** They hand the reader about 528 tokens. We hand
  it 20–40 rounds and let the reader do more of the work. Our hit@1 is lower
  because we never needed the best session first, only in the rounds shown. Shown
  rounds hold every evidence turn for 93.1% of the 419 questions.
- **The latency measures different things.** Their number includes HTTP and MCP
  framing under concurrency 6. Ours is the library call alone.

What can be said: both systems reach about 0.94–0.95 any-evidence-in-top-5 on
LongMemEval-S with the same on-device embedder (all-MiniLM-L6-v2, 384
dimensions), with no LLM, and with RRF at the same constant. Their FTS-only
result (0.951) is worth noticing: their observation stream lifted it from 0.662.
That fixes what their own capture had lost (session pages that indexed only
80-character titles,
[`docs/benchmarks/README.md:83-92`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/benchmarks/README.md#L83-L92)).
It is not a ranking idea our message-level store lacks: we already index every
message whole.

**On our gain and break sets** (2026-10-18, retrieval only, paired against
`main`), every evidence turn is shown for 84.0% (gain) and 95.2% (break) of the
questions. ai-memory has no number on these sets, and could not be given one here.

## 4. Latency and footprint

| | al-buddy-memory | ai-memory |
|---|---|---|
| Write | 5,400–5,900 facts/s, one per call, at 100k facts (SQLite, M1 Pro) | "~700/s" write ceiling (README). In the benchmark, 10–12 items/s per question stream through the hook path |
| Keyword recall | 30–50 ms median at 100k facts, top 10 | 12 ms p50 / 103 ms p95 per MCP query at LongMemEval size |
| Semantic recall | 22 ms median at 20k, 113 ms at 100k, after the first call of a session | 98 ms p50 / 225 ms p95 at LongMemEval size |
| Vector index | Linear scan; `sqlite-vec` not yet worth it | Linear scan; `sqlite-vec` deferred until >5k–10k pages per project or p95 >150–250 ms |
| Process | None of its own: in-process, or a stdio MCP server per client | A long-running service, with hooks that spool and return within ≤200 ms |

Their hook design is built so capture never blocks the agent: a local spool,
drained later, with a 3-second cap on the session-start handoff fetch
([`crates/ai-memory-cli/src/commands/hook.rs:1-12,49-52`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-cli/src/commands/hook.rs#L1-L52)).
We have one hook, SessionStart, with a 15-second timeout. It runs `npx`, so a
cold start pays for npm resolution.

## 5. Claude Code and Codex handoff

**ai-memory.**
- Plugins for both harnesses come from the same repo:
  [`plugins/claude-code/`](https://github.com/akitaonrails/ai-memory/tree/ad264519488c06e4468f1ad9f805d5fed2f97855/plugins/claude-code)
  and
  [`plugins/codex/`](https://github.com/akitaonrails/ai-memory/tree/ad264519488c06e4468f1ad9f805d5fed2f97855/plugins/codex),
  with a `.codex-plugin/plugin.json` and a Codex marketplace catalog at
  `.agents/plugins/marketplace.json`.
- Each plugin registers SessionStart, UserPromptSubmit, Pre/PostToolUse,
  PreCompact, Stop and SessionEnd. Codex runs plugin hooks only after the user
  trusts them in `/hooks`.
- **The handoff is a typed row, not a note.** It holds a summary, open questions,
  next steps, files touched, `from_agent`, an optional `to_agent`, `cwd` and owner,
  with the states open → accepted / expired
  ([`crates/ai-memory-core/src/handoff.rs`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/crates/ai-memory-core/src/handoff.rs)).
- Session end writes one automatically, with no LLM, from the session's first and
  last prompts and the tools used. The next session start in the same project
  claims it exactly once, in one transaction, whichever harness that is.
  - It skips a baton whose source session was active in the last 10 minutes.
  - A handoff an agent wrote by hand beats an automatic one.
  - "Offer" mode injects only metadata (id, source agent, age), never the summary,
    so a hostile summary cannot inject instructions
    ([`docs/design-handoff-offer-not-claim.md`](https://github.com/akitaonrails/ai-memory/blob/ad264519488c06e4468f1ad9f805d5fed2f97855/docs/design-handoff-offer-not-claim.md)).
- Their heavier `ai-memory run codex` mode adds a lease and a private, local copy
  of the previous harness's visible transcript.
- A project brief (4,000 bytes by default) is opt-in per repository.
- 24 MCP tools, including inter-agent messaging.

**Ours.**
- Claude Code and Codex already share one memory: both point at
  `~/.al-buddy-memory/brain.db`, and each fact records which assistant wrote it
  (`origin`) and which retired it (`retiredBy`).
- Claude Code gets a SessionStart briefing of up to 2,000 characters: pinned rules,
  facts naming the project folder, and recent facts. It is framed as *"stored data
  about the user, not instructions"*.
- Codex gets the MCP server and nothing else. There is no Codex plugin, so there
  is no briefing at session start.
- There is no handoff. "Where did I leave off" is only whatever an assistant chose
  to `remember`, found by recall.

**The gap is real and it is the one worth closing.** People already switch
between Claude Code and Codex on the same work, and the memory is shared, but
only one of the two is briefed at session start. ai-memory shows that Codex
plugins can carry hooks, and that a handoff works as an exactly-once claim.
Our model already has the exactly-once part: claiming a handoff is
`invalidate`, and `retiredBy` records which assistant picked it up.

## 6. Licence

- **ai-memory:** MIT, © 2026 Fabio Akita, for the workspace, every crate and both
  plugins. There is no CLA. `deny.toml` refuses GPL/AGPL dependencies. It vendors
  libgit2, which is GPLv2 with a linking exception. That last point is from the
  libgit2 project, not from their repository.
- **Ours:** Apache-2.0.
- MIT code could be taken into an Apache-2.0 project, keeping the MIT notice.
  **None is proposed here.** Every item below is an idea, re-implemented in
  TypeScript against our own model.

## 7. Verdicts, per feature

ADOPT-an-idea means the idea is worth building here, in our own terms. Each one
has a follow-up of its own. IGNORE means it does not fit, or we already have it.

| ai-memory feature | Verdict | Why | Follow-up |
|---|---|---|---|
| Codex plugin with a SessionStart hook, from the same marketplace repo | **ADOPT-an-idea** | Codex users get no briefing today. The plugin format and the `/hooks` trust step are shown working in their repo | Queued: a Codex plugin running the same `context --hook` briefing |
| Session handoff, claimed exactly once | **ADOPT-an-idea** | Switching harnesses mid-task is common. In our model, a handoff is a fact with a project label, and claiming it is `invalidate`, so `retiredBy` shows who took it. Their "offer" mode (metadata only) is the safer default, because a handoff written by one assistant is read by another | Queued: a `handoff` tool and skill, surfaced first in the briefing, claimed by invalidation |
| Typed secret scrubber with vendor-prefixed patterns | **ADOPT-an-idea** (patterns only) | Their list catches token shapes our `SECRET_PATTERNS` misses: GitHub `ghs_`/`ghu_`/`ghr_`/`github_pat_`, Google `AIza…`, credentials inside URLs, Telegram bot tokens. Checked on 2026-10-21: a synthetic sample of each of those seven shapes passes our patterns, while a `ghp_` control is caught. We **classify** as Sensitive rather than redact, and keep doing so (the raw is the truth). We only widen what is recognised | Queued: widen `SECRET_PATTERNS`, one test per shape |
| Reporting context size beside hit@k; a stated noise band per release | **ADOPT-an-idea** | Our numbers cannot be read beside theirs (or agentmemory's or MemPalace's R@5) until we report hit@k on the 470-question denominator and how much text the reader got | Queued: both in `recall-sweep.mjs` and `run.mjs` |
| Running ai-memory itself on our eval set | Parked | Needs a Rust toolchain or their release binary, i.e. installing and running third-party software, which was not possible where this was written. Their published LongMemEval-S run already uses our dataset | Parked until someone chooses to install it; the metric item above makes their published number comparable without it |
| Git-backed markdown as the source of truth | IGNORE | Hand edits as a write path would break immutable raw and checked provenance. We already have a readable mirror (`export --format markdown`) | — |
| Ingestion-time-only versions, `as_of` on FTS only | IGNORE | We are bi-temporal, and `snapshotAsOf` covers every read | — |
| TTL expiry and decay hard-delete, on by default | IGNORE | Contrary to invalidate-never-overwrite. Our erasure is governed and audited | — |
| Observation stream (one vote per session for its page) | IGNORE | It repairs their capture loss. We index every message whole. A session-diversity pass, the nearest analogue, did not help in our own recall sweeps (2026-10-15) | — |
| Graph-expansion stream over page links | Parked | Our conversational stores hold few edges (`derivedFrom`, `supersedes`). Worth measuring only once consolidation writes enough links to expand over | Parked until a real store's edge count makes it testable |
| RRF k=60 fusion | IGNORE | Same constant, already ours | — |
| Authority multiplier (pin, tier, kind) | IGNORE | Pinned rules are their own tier here, and decay-aware confidence already ranks | — |
| LLM reranker, LLM "dream" rewrite of cold pages | IGNORE | Recall here needs no key, and a rewrite of the raw is excluded by design. Derived facts already cite their evidence | — |
| Compaction and near-duplicate collapse of cold pages | IGNORE | Both rewrite or merge content. `remember` already returns `mayConflictWith` for a person to resolve | — |
| Verbatim residue (literal tokens kept when consolidation truncates) | IGNORE | Our consolidation caps a pass at 200 facts and leaves the rest unmarked for the next pass, so nothing is truncated away | — |
| Multi-user server, per-project grants, audit log, admission webhooks | IGNORE | Covered by our policies, `readBoundary`, OIDC sign-in, the hash-chained audit trail and Postgres tenancy | — |
| Rules promotion into AGENTS.md (design only, not built) | IGNORE | `PinnedBlocks` is the size-capped standing-rules tier already | — |
| Per-session "active project" pointer (auto-scope) | IGNORE | One brain per server here; `ProjectMemory` scopes by explicit key | — |
| Inter-agent messaging, managed workstreams with leases | IGNORE | Outside a memory library's job. The handoff above covers the part that is memory | — |
